"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { inspectSource, inspectMongooseSchemas, inspectPrismaSchema, tokenize } = require("./business-discovery-source.js");

test("parses root-level Express registrations and scheduled work", () => {
  const findings = inspectSource(`
    const express = require('express');
    const cron = require('node-cron');
    const app = express();
    const router = express.Router();
    app.get('/orders', listOrders);
    router.post('/orders', createOrder);
    router.route('/order/:id').put(updateOrder);
    cron.schedule('0 * * * *', reconcile);
    setInterval(checkQueue, 1000);
  `);
  // COORD-582 R1: the app is never served in this file, so its prefix is not proven.
  assert.ok(findings.some((f) => f.kind === "integration_contract" && f.subject === "GET /orders" && f.resolution_status === "unresolved_mount"));
  assert.ok(findings.some((f) => f.kind === "integration_contract" && f.subject === "POST /orders"));
  assert.ok(findings.some((f) => f.kind === "integration_contract" && f.subject === "PUT /order/:id"));
  assert.ok(findings.some((f) => f.kind === "workflow" && f.subject === "cron.schedule"));
  assert.ok(findings.some((f) => f.kind === "hypothesis" && f.subject === "setInterval" && f.resolution_status === "timer_only"));
});

test("parses JSX and createElement while ignoring commented and quoted syntax", () => {
  const findings = inspectSource(`
    // app.get('/fake', handler); cron.schedule('*', fake);
    const sample = "router.post('/fake', handler)";
    const pattern = /app.get('fake')/;
    export function Checkout() { return <OrderCard />; }
    const fallback = React.createElement(EmptyState, {});
  `);
  assert.ok(findings.some((f) => f.kind === "ux_behavior" && f.subject === "OrderCard"));
  assert.ok(findings.some((f) => f.kind === "ux_behavior" && f.subject === "EmptyState"));
  assert.equal(findings.some((f) => f.kind === "integration_contract"), false);
  assert.equal(findings.some((f) => f.kind === "workflow"), false);
});

test("a paired JSX component is recognized by its matching close tag", () => {
  const findings = inspectSource(`
    export function Page() {
      return <Panel title="Orders"><b>bold</b><Row /></Panel>;
    }
    const narrow = a < Limit > b;
  `);
  assert.ok(findings.some((f) => f.kind === "ux_behavior" && f.subject === "Panel"));
  assert.ok(findings.some((f) => f.kind === "ux_behavior" && f.subject === "Row"));
  assert.equal(findings.some((f) => f.subject === "b" || f.subject === "Limit"), false);
});

test("tokens carry the source offsets of the text they were read from", () => {
  const text = "const a = 'two \\'words\\''; // note\n/* block\n comment */ match: /^[a-z]+$/i, `tpl`";
  const tokens = tokenize(text);
  assert.deepEqual(tokens.map((token) => token.type), ["name", "name", "punct", "string", "punct", "name", "punct", "regex", "punct", "template"]);
  for (const token of tokens) {
    const slice = text.slice(token.start, token.end);
    if (token.type === "regex") assert.equal(slice, "/^[a-z]+$/i");
    else if (token.type === "string") assert.equal(slice, "'two \\'words\\''");
    else if (token.type === "template") assert.equal(slice, "`tpl`");
    else assert.equal(slice, token.value);
  }
});

test("an unterminated trailing comment ends tokenization with every earlier token kept", () => {
  // A line comment with no closing newline and a block comment with no `*/`
  // both run to the end of the text; nothing inside them becomes a token.
  assert.deepEqual(tokenize("a = 1 // app.get('/x', h)").map((token) => token.value), ["a", "=", "1"]);
  assert.deepEqual(tokenize("a = 1 /* app.get('/x', h)").map((token) => token.value), ["a", "=", "1"]);
});

test("a leading slash opens a regex while a slash after an operand divides", () => {
  // With no previous token the slash is in expression-start position.
  assert.deepEqual(tokenize("/a,b/g.test(x)").map((token) => token.type), ["regex", "punct", "name", "punct", "name", "punct"]);
  // After a name the slash is division, so `/ b /` is never swallowed as a regex.
  assert.deepEqual(tokenize("x = a / b / c").map((token) => `${token.type}:${token.value}`),
    ["name:x", "punct:=", "name:a", "punct:/", "name:b", "punct:/", "name:c"]);
});

const fields = (result) => result.fieldRules.map((rule) => `${rule.model}|${rule.field}|${rule.constraints.join(", ")}`);
const named = (result) => result.validators.map((found) => `${found.name}|${found.model}|${found.field}|${found.message}`);

test("COORD-583: Mongoose field definitions follow Mongoose's own reading of a schema body", () => {
  const result = inspectMongooseSchemas(`
    const base = { shared: String };
    const orderSchema = new Schema({
      ...base,
      shorthand,
      helper() { return 1; },
      'quoted-key': String,
      owner: Schema.Types.ObjectId,
      count: 5,
      extras: [],
      limits: { min: 0, max: { type: Number, max: 10 } },
      meta: { type: { type: String }, label: String },
      lines: [{ sku: String, qty: { type: Number, min: 1, default: 1 } }],
      code: { type: String, minLength: 2, maxLength: 8, unique: true, lowercase: true },
    });
    module.exports = connection.model('Order', orderSchema);
  `);
  assert.deepEqual(fields(result), [
    "Order|quoted-key|type: String",
    "Order|owner|type: Schema.Types.ObjectId",
    "Order|limits.max|type: Number, max: 10",
    "Order|meta.type|type: String",
    "Order|meta.label|type: String",
    "Order|lines[].sku|type: String",
    "Order|lines[].qty|type: Number, min: 1, default: 1",
    "Order|code|type: String, minLength: 2, maxLength: 8, unique: true",
  ]);
  assert.deepEqual(result.validators, []);
  // Offsets point at the field name in the original text.
  for (const rule of result.fieldRules) assert.ok(rule.at > 0);
});

test("COORD-583: every validate form yields its named validators and nothing for anonymous ones", () => {
  const result = inspectMongooseSchemas(`
    const { model } = require('mongoose');
    const s = new Schema({
      a: { type: String, validate: isA },
      b: { type: String, validate: checks.b.strict },
      c: { type: String, validate: { validator: isC, message: 'C is wrong' } },
      d: { type: String, validate: { validator: isD, msg: 'D is wrong' } },
      e: { type: String, validate: { validator: isE, message: buildMessage } },
      f: { type: String, validate: [isF, 'F is wrong'] },
      g: { type: String, validate: [isG] },
      h: { type: String, validate: [isH, { message: 'ignored options object' }] },
      i: { type: String, validate: [{ validator: isI1, message: 'I1' }, { validator: isI2 }] },
      j: { type: String, validate: function isJ(v) { return v; } },
      k: { type: String, validate: { validator: function isK(v) { return v; } } },
      anonymousArrow: { type: String, validate: (v) => v.length > 2 },
      anonymousFunction: { type: String, validate: function (v) { return v; } },
      anonymousAsync: { type: String, validate: async function (v) { return v; } },
      factoryCall: { type: String, validate: buildValidator('x') },
      emptyList: { type: String, validate: [] },
      noValidator: { type: String, validate: { message: 'no function here' } },
    });
    s.path('a').validate(isUnique, 'A must be unique');
    s.path('b').validate(isPresent);
    s.path(dynamicName).validate(notRead);
    model('Thing', s);
  `);
  assert.deepEqual(named(result), [
    "isA|Thing|a|null",
    "checks.b.strict|Thing|b|null",
    "isC|Thing|c|C is wrong",
    "isD|Thing|d|D is wrong",
    "isE|Thing|e|null",
    "isF|Thing|f|F is wrong",
    "isG|Thing|g|null",
    "isH|Thing|h|null",
    "isI1|Thing|i|I1",
    "isI2|Thing|i|null",
    "isJ|Thing|j|null",
    "isK|Thing|k|null",
    "isUnique|Thing|a|A must be unique",
    "isPresent|Thing|b|null",
  ]);
});

test("COORD-583: schema lookup handles qualifiers, type arguments, inline models and unbound schemas", () => {
  const result = inspectMongooseSchemas(`
    const { model } = require('mongoose');
    const plain = new Schema({ a: String });
    const qualified = new mongoose.Schema({ b: String });
    const called = mongoose.Schema({ c: String });
    const typed = new Schema<Doc, Model<Doc>>({ d: String });
    export const Typed = model<Doc>('Typed', typed);
    model('Plain', plain);
    model('Inline', new Schema({ e: String }));
    model('NotASchema', someOtherValue);
    model(dynamicName, plain);
    export default new Schema({ f: String });
    const fromVariable = new Schema(definition);
    const comparison = Schema < limit;
    unbound.path('g').validate(isG);
    const options = { type: String, min: 1, validate: isOutside };
  `);
  assert.deepEqual(fields(result), [
    "Plain|a|type: String",
    "null|b|type: String",
    "null|c|type: String",
    "Typed|d|type: String",
    "Inline|e|type: String",
    "null|f|type: String",
  ]);
  assert.deepEqual(named(result), ["isG|null|g|null"]);
});

test("COORD-584: model registries are static entities and comments or schema filenames are not", () => {
  const mongoose = inspectMongooseSchemas(`
    const { model } = require('mongoose');
    // mongoose.model("CommentOnly", fake);
    const invoiceSchema = new Schema({ id: String });
    mongoose.model("Invoice", invoiceSchema, "invoices");
    model("Order", new Schema({ id: String }));
    const sample = "connection.model('StringOnly', schema)";
    const unregistered = new Schema({ code: String });
  `);
  assert.deepEqual(mongoose.models.map(({ name, collection }) => ({ name, collection })), [
    { name: "Invoice", collection: "invoices" },
    { name: "Order", collection: null },
  ]);
  const retrievalAndUnrelated = inspectMongooseSchemas(`
    const cached = mongoose.model('User');
    function model(name, schema) { return schema; }
    model('NotMongoose', new Schema({ id: String }));
    const userSchema = new Schema({});
    mongoose.model('EmptyUser', userSchema);
  `);
  assert.deepEqual(retrievalAndUnrelated.models.map(({ name }) => name), ["EmptyUser"],
    "a lookup and unrelated bare helper are not registrations, but a real empty schema is retained");
  const unrelatedAlias = inspectMongooseSchemas(`
    import { other as model } from 'mongoose';
    model('NotMongoose', new Schema({ id: String }));
  `);
  assert.deepEqual(unrelatedAlias.models, [], "an unrelated imported member aliased to model is not a Mongoose registration");
  const shadowedAlias = inspectMongooseSchemas(`
    import { other as model } from 'mongoose';
    function model(name, schema) { return schema; }
    model('False', new Schema({ id: String }));
  `);
  assert.deepEqual(shadowedAlias.models, [], "a local function cannot inherit an unrelated imported binding's authority");
  const shadowedImportedModel = inspectMongooseSchemas(`
    import { model as other } from 'mongoose';
    function model(name, schema) { return schema; }
    model('False', new Schema({ id: String }));
  `);
  assert.deepEqual(shadowedImportedModel.models, [], "an aliased imported function does not authorize a local function with the same name");
  const multiMemberCommonJs = inspectMongooseSchemas(`
    const { Schema, model } = require('mongoose');
    const orderSchema = new Schema({ reference: { type: String, validate: isOrderReference } });
    module.exports = model('Order', orderSchema);
  `);
  assert.deepEqual(multiMemberCommonJs.models.map(({ name }) => name), ["Order"],
    "a named Mongoose model registration is recognized with multiple destructured imports");
  assert.deepEqual(fields(multiMemberCommonJs), ["Order|reference|type: String"]);
  assert.deepEqual(named(multiMemberCommonJs), ["isOrderReference|Order|reference|null"]);
  const explicitCommonJsBinding = inspectMongooseSchemas(`
    const { Schema, model: model } = require('mongoose');
    const orderSchema = new Schema({ reference: String });
    module.exports = model('Order', orderSchema);
  `);
  assert.deepEqual(explicitCommonJsBinding.models.map(({ name }) => name), ["Order"]);
  const aliasedCommonJsBinding = inspectMongooseSchemas(`
    const { Schema, model: registerModel } = require('mongoose');
    const orderSchema = new Schema({ reference: String });
    module.exports = model('Order', orderSchema);
  `);
  assert.deepEqual(aliasedCommonJsBinding.models, [], "a non-model local alias must not authorize a bare model call");
  const unmatchedCommonJsBinding = inspectMongooseSchemas(`
    } = require('mongoose');
    const orderSchema = new Schema({ reference: String });
    module.exports = model('Order', orderSchema);
  `);
  assert.deepEqual(unmatchedCommonJsBinding.models, [], "an unmatched close brace must not authorize a bare model call");
  const dynamicNames = inspectMongooseSchemas(`
    import { model } from 'mongoose';
    const schema = new Schema({ id: String });
    model('Prefix' + suffix, schema);
    model('CollectionDynamic', schema, 'prefix' + suffix);
  `);
  assert.deepEqual(dynamicNames.models.map(({ name, collection }) => ({ name, collection })), [
    { name: "CollectionDynamic", collection: null },
  ], "only a single static string token is an exact model or collection name");
  const prisma = inspectPrismaSchema(`model Invoice { id String @id @@map("invoices") }
model EmptyModel { }`);
  assert.deepEqual(prisma.models.map(({ name, collection }) => ({ name, collection })), [
    { name: "Invoice", collection: "invoices" },
    { name: "EmptyModel", collection: null },
  ]);
});

test("COORD-583: a truncated or empty source yields what was complete and never throws", () => {
  assert.deepEqual(fields(inspectMongooseSchemas("const s = new Schema({ a: String, b: Number")), ["null|a|type: String", "null|b|type: Number"]);
  assert.deepEqual(fields(inspectMongooseSchemas("const s = new Schema({ a: String, b: { type: Number, min:")), ["null|a|type: String"]);
  assert.deepEqual(fields(inspectMongooseSchemas("const s = new Schema({ a: { type: Number, min: 3, max:")), []);
  assert.deepEqual(inspectMongooseSchemas("const s = new Schema<Broken"), { fieldRules: [], validators: [], models: [] });
  assert.deepEqual(inspectMongooseSchemas("Schema({ a: { type: String, validate: function"), { fieldRules: [], validators: [], models: [] });
  assert.deepEqual(inspectMongooseSchemas(), { fieldRules: [], validators: [], models: [] });
  assert.deepEqual(inspectPrismaSchema(), { fieldRules: [], validators: [], models: [] });
});

test("COORD-583: Prisma model blocks yield scalar and enum field types with their attributes", () => {
  const result = inspectPrismaSchema([
    "datasource db {",
    "  provider = \"postgresql\"",
    "}",
    "enum Status {",
    "  OPEN",
    "  CLOSED @map(\"closed\")",
    "  // RETIRED",
    "  @@map(\"status\")",
    "}",
    "model Ticket {",
    "  id       Int      @id @default(autoincrement())",
    "  title    String   @db.VarChar(80) @unique // short title",
    "  body     String?",
    "  status   Status   @default(OPEN)",
    "  amount   Decimal  @db.Decimal(10, 2)",
    "  tags     String[]",
    "  payload  Json?",
    "  raw      Unsupported(\"circle\")",
    "  owner    User     @relation(fields: [ownerId], references: [id])",
    "  ownerId  Int",
    "  comments Comment[]",
    "  @@unique([title, ownerId])",
    "}",
    "",
  ].join("\n"));
  assert.deepEqual(fields(result), [
    "Ticket|id|type: Int, @id @default(autoincrement())",
    "Ticket|title|type: String, @db.VarChar(80) @unique",
    "Ticket|body|type: String, optional",
    "Ticket|status|type: Status, enum: [OPEN, CLOSED], @default(OPEN)",
    "Ticket|amount|type: Decimal, @db.Decimal(10, 2)",
    "Ticket|tags|type: String[]",
    "Ticket|payload|type: Json, optional",
    "Ticket|ownerId|type: Int",
  ]);
  assert.deepEqual(result.validators, []);
});

test("COORD-584: comments and computed schema arguments are not declarations", () => {
  const schemas = inspectMongooseSchemas(`mongoose.model('Computed', new Schema({}) || fallback);`);
  assert.deepEqual(schemas.models, []);
  const prisma = inspectPrismaSchema(`/*
model Commented { id String @id }
*/
model Real {
 id String @id
 // @@map("wrong")
 @@map("actual")
}`);
  assert.deepEqual(prisma.models.map(({name, collection}) => ({name, collection})), [{name: "Real", collection: "actual"}]);
});

test("COORD-584: qualified schemas, duplicate registrations and foreign imports", () => {
  const result = inspectMongooseSchemas(`
    foreign.model('Foreign', new Schema({}));
    mongoose.model('Inline', new mongoose.Schema({}), 'inline');
    mongoose.model('Inline', new mongoose.Schema({}), 'inline');
    mongoose.model('Inline', new mongoose.Schema({}), 'alternate');
  `);
  assert.deepEqual(result.models.map(({name, collection}) => ({name, collection})), [
    {name:'Inline',collection:'inline'}, {name:'Inline',collection:'alternate'},
  ]);
  assert.deepEqual(inspectMongooseSchemas(`import { model } from 'unrelated'; model('Foreign',new Schema({}));`).models, []);
  assert.deepEqual(inspectMongooseSchemas(`import { "model" as model } from 'mongoose'; model('UnsupportedQuotedImport',new Schema({}));`).models, []);
});
