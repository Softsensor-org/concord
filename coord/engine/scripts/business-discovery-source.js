"use strict";

const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const sourceParser = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/business-discovery-source-parser.js"));

// Bounded token utilities remain for schema-language extraction below.
// Registration and component syntax is parsed by the Babel-backed static AST
// resolver in coord/engine/scripts/business-discovery-source-parser.js.
function tokenize(source) {
  const text = String(source || "");
  const tokens = [];
  for (let i = 0; i < text.length && tokens.length < 50000;) {
    const char = text[i];
    const start = i;
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (char === "/" && /^(?:=|\(|\[|\{|,|:|;|!|\?|return|throw|=>)$/.test(tokens.at(-1)?.value || "=")) {
      let end = i + 1;
      let inClass = false;
      while (end < text.length && text[end] !== "\n") {
        if (text[end] === "\\") { end += 2; continue; }
        if (text[end] === "[") inClass = true;
        else if (text[end] === "]") inClass = false;
        else if (text[end] === "/" && !inClass) break;
        end += 1;
      }
      if (text[end] === "/") {
        i = end + 1;
        while (i < text.length && /[a-z]/i.test(text[i])) i += 1;
        tokens.push({ type: "regex", value: "<regex>", start, end: i });
        continue;
      }
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          if (i + 1 < text.length) value += text[i + 1];
          i += 2;
        } else if (text[i] === quote) { i += 1; break; }
        else { value += text[i]; i += 1; }
      }
      tokens.push({ type: quote === "`" ? "template" : "string", value, start, end: i });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = i + 1;
      while (end < text.length && /[\w$]/.test(text[end])) end += 1;
      tokens.push({ type: "name", value: text.slice(i, end), start, end });
      i = end;
      continue;
    }
    tokens.push({ type: "punct", value: char, start, end: start + 1 });
    i += 1;
  }
  return tokens;
}

function inspectSource(source) {
  return inspectSourceDetailed(source).findings;
}

function inspectSourceDetailed(source, options) {
  return sourceParser.inspectSource(source, options);
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const MONGOOSE_CONSTRAINTS = new Set(["type", "required", "unique", "enum", "min", "max", "minlength", "maxlength", "minLength", "maxLength", "match", "default"]);

// COORD-583 — reads field definitions only from the body of a Mongoose
// Schema({...}) call, so `type`, `min`, `max` and `validate` keys in any other
// object literal are never reported. Returns one entry per declared field with
// its constraint options in source order, and one entry per named validator.
function inspectMongooseSchemas(source) {
  const text = String(source || "");
  const tokens = tokenize(text);
  const val = (index) => tokens[index]?.value;
  // String contents are tokens too, so brackets and commas count only as punctuation.
  const punct = (index) => (tokens[index]?.type === "punct" ? tokens[index].value : null);
  const raw = (from, to) => text.slice(tokens[from].start, tokens[to - 1].end).replace(/\s+/g, " ");

  // Index of the bracket closing the one at `open`; the token count when the
  // source is cut off before it closes.
  function closeOf(open) {
    let depth = 0;
    for (let i = open; i < tokens.length; i += 1) {
      if (OPENERS.has(punct(i))) depth += 1;
      else if (CLOSERS.has(punct(i)) && (depth -= 1) === 0) return i;
    }
    return tokens.length;
  }

  // Top-level comma-separated [from, to) token ranges inside the bracket at `open`.
  function parts(open) {
    const end = closeOf(open);
    const ranges = [];
    let from = open + 1;
    for (let i = from; i <= end; i += 1) {
      if (i === end || punct(i) === ",") {
        if (i > from) ranges.push([from, i]);
        from = i + 1;
      } else if (OPENERS.has(punct(i))) {
        i = closeOf(i);
      }
    }
    return ranges;
  }

  // `key: value` properties of the object literal at `open`. Spreads, methods
  // and shorthand properties have no declared value and are left out.
  function props(open) {
    return parts(open)
      .filter(([from, to]) => ["name", "string"].includes(tokens[from].type) && punct(from + 1) === ":" && to > from + 2)
      .map(([from, to]) => ({ key: tokens[from].value, at: tokens[from].start, from: from + 2, to }));
  }

  // Skips a TypeScript type-argument list such as Schema<Order, Model<Order>>.
  function afterTypeArgs(index) {
    if (punct(index) !== "<") return index;
    let depth = 0;
    let i = index;
    do {
      depth += punct(i) === "<" ? 1 : punct(i) === ">" ? -1 : 0;
      i += 1;
    } while (depth > 0 && i < tokens.length);
    return i;
  }

  // Named validators in one `validate` value: an identifier or dotted member, a
  // named function expression, or { validator, message }. An anonymous function
  // has no name to report and yields nothing.
  function validatorsIn(from, to, message = null) {
    if (punct(from) === "[") return validatorsInList(from);
    if (punct(from) === "{") {
      const entries = props(from);
      const fn = entries.find((entry) => entry.key === "validator");
      const note = entries.find((entry) => (entry.key === "message" || entry.key === "msg") && tokens[entry.from].type === "string");
      return fn ? validatorsIn(fn.from, fn.to, note ? tokens[note.from].value : null) : [];
    }
    if (val(from) === "function") return tokens[from + 1]?.type === "name" ? [{ name: val(from + 1), message }] : [];
    const dotted = tokens.slice(from, to).every((token, offset) => (offset % 2 === 0 ? token.type === "name" : token.type === "punct" && token.value === "."));
    return dotted ? [{ name: raw(from, to), message }] : [];
  }

  // [fn, "message"], a list of { validator } objects, or the arguments of
  // schema.path("field").validate(fn, "message").
  function validatorsInList(open) {
    const [first, second] = parts(open);
    if (!first) return [];
    if (punct(first[0]) === "{") return parts(open).flatMap(([from, to]) => validatorsIn(from, to));
    return validatorsIn(first[0], first[1], second && tokens[second[0]].type === "string" ? tokens[second[0]].value : null);
  }

  const fieldRules = [];
  const validators = [];
  const models = [];

  // Mongoose reads an object with a `type` option as one field definition and
  // any other object as a nested document whose keys are fields; an array
  // declares its element. The same reading is applied here.
  function field(name, at, from, to, model) {
    if (punct(from) === "[") {
      const [element] = parts(from);
      if (element) field(`${name}[]`, at, element[0], element[1], model);
      return;
    }
    if (punct(from) !== "{") {
      if (tokens[from].type === "name") fieldRules.push({ field: name, model, at, constraints: [`type: ${raw(from, to)}`] });
      return;
    }
    const options = props(from);
    const type = options.find((option) => option.key === "type");
    if (!type || punct(type.from) === "{") {
      for (const child of options) field(`${name}.${child.key}`, child.at, child.from, child.to, model);
      return;
    }
    fieldRules.push({
      field: name,
      model,
      at,
      constraints: options.filter((option) => MONGOOSE_CONSTRAINTS.has(option.key)).map((option) => `${option.key}: ${raw(option.from, option.to)}`),
    });
    for (const option of options.filter((candidate) => candidate.key === "validate")) {
      for (const found of validatorsIn(option.from, option.to)) validators.push({ ...found, field: name, model, at: option.at });
    }
  }

  // model('Name', schemaVariable) names the schema bound to that variable.
  const modelByVariable = new Map();
  const schemaBindings = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "name" || val(i) !== "Schema") continue;
    const open = afterTypeArgs(i + 1);
    if (punct(open) !== "(") continue;
    let before = i - 1;
    if (punct(before) === ".") before -= 2;
    if (val(before) === "new") before -= 1;
    if (punct(before) === "=" && tokens[before - 1]?.type === "name") {
      schemaBindings.add(val(before - 1));
    }
  }
  const mongooseModelImported = (() => {
    for (let i = 0; i < tokens.length; i += 1) {
      if (val(i) === "import" && punct(i + 1) === "{") {
        const end = closeOf(i + 1);
        const hasLocalModelBinding = parts(i + 1).some(([from, to]) => {
          if (tokens[from]?.type !== "name") return false;
          const imported = val(from);
          const local = val(from + 1) === "as" ? val(from + 2) : imported;
          return imported === "model" && local === "model" && to <= from + 3;
        });
        if (!hasLocalModelBinding) continue;
        for (let j = end + 1; j < Math.min(end + 5, tokens.length); j += 1) {
          if (tokens[j]?.type === "string" && val(j) === "mongoose") return true;
        }
      }
      if (val(i) !== "require" || punct(i + 1) !== "(" || tokens[i + 2]?.type !== "string" ||
          val(i + 2) !== "mongoose" || punct(i + 3) !== ")" ||
          punct(i - 1) !== "=" || punct(i - 2) !== "}") continue;
      // Locate the object binding paired with the assignment. A valid
      // `const { Schema, model } = require("mongoose")` binding can include
      // several properties; the old four-token check only accepted `{ model }`.
      let open = -1;
      let depth = 0;
      for (let j = i - 2; j >= 0; j -= 1) {
        if (punct(j) === "}") depth += 1;
        else if (punct(j) === "{") {
          depth -= 1;
          if (depth === 0) { open = j; break; }
        }
      }
      if (open < 0) continue;
      const hasLocalModelBinding = parts(open).some(([from, to]) =>
        tokens[from]?.type === "name" && val(from) === "model" &&
        (to === from + 1 || (punct(from + 1) === ":" && val(from + 2) === "model" && to === from + 3)));
      if (hasLocalModelBinding) return true;
    }
    return false;
  })();
  function isSchemaExpression(range) {
    if (!range) return false;
    let from = range[0];
    const to = range[1];
    if (val(from) === "new") from += 1;
    if (tokens[from]?.type === "name" && schemaBindings.has(val(from)) && from + 1 === to) return true;
    if (tokens[from]?.type === "name" && val(from) === "mongoose" && punct(from + 1) === ".") from += 2;
    if (tokens[from]?.type !== "name" || val(from) !== "Schema") return false;
    const open = afterTypeArgs(from + 1);
    return punct(open) === "(" && closeOf(open) + 1 === to;
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "name" || val(i) !== "model") continue;
    const open = afterTypeArgs(i + 1);
    if (punct(open) !== "(") continue;
    const args = parts(open);
    const nameArg = args[0];
    if (!nameArg || nameArg[1] !== nameArg[0] + 1 || tokens[nameArg[0]]?.type !== "string") continue;
    const receiver = punct(i - 1) === "." ? val(i - 2) : null;
    if (receiver && !["mongoose", "connection"].includes(receiver)) continue;
    if (!receiver && !mongooseModelImported) continue;
    const name = val(nameArg[0]);
    const schemaArg = args[1];
    if (!isSchemaExpression(schemaArg)) continue;
    if (schemaArg && punct(schemaArg[0] - 1) === "," && tokens[schemaArg[0]]?.type === "name" && schemaBindings.has(val(schemaArg[0]))) {
      modelByVariable.set(val(schemaArg[0]), name);
    }
    const collectionArg = args[2];
    const collection = collectionArg && collectionArg[1] === collectionArg[0] + 1 && tokens[collectionArg[0]]?.type === "string"
      ? val(collectionArg[0])
      : null;
    if (!models.some((model) => model.name === name && model.collection === collection)) {
      models.push({ name, collection, at: tokens[i].start });
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== "name") continue;
    const open = val(i) === "Schema" ? afterTypeArgs(i + 1) : -1;
    if (punct(open) === "(" && punct(open + 1) === "{") {
      // Step back over `new` and a `mongoose.` qualifier to reach either the
      // variable the schema is assigned to or an enclosing model('Name', ...).
      let before = i - 1;
      if (punct(before) === ".") before -= 2;
      if (val(before) === "new") before -= 1;
      const model = punct(before) === "," && tokens[before - 1]?.type === "string"
        ? val(before - 1)
        : modelByVariable.get(val(before - 1)) || null;
      for (const entry of props(open + 1)) field(entry.key, entry.at, entry.from, entry.to, model);
    }
    if (val(i) === "path" && punct(i - 1) === "." && punct(i + 1) === "(" && tokens[i + 2]?.type === "string" && punct(i + 3) === ")" && punct(i + 4) === "." && val(i + 5) === "validate" && punct(i + 6) === "(") {
      for (const found of validatorsInList(i + 6)) {
        validators.push({ ...found, field: val(i + 2), model: modelByVariable.get(val(i - 2)) || null, at: tokens[i].start });
      }
    }
  }
  return { fieldRules, validators, models };
}

const PRISMA_SCALARS = new Set(["String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes"]);

// COORD-583 — Prisma's schema language declares one `name Type attributes`
// field per line inside a model block. A scalar or enum type is a field
// constraint; a field typed as another model is a relation and is left out.
// The attribute text follows the type as the last constraint.
function inspectPrismaSchema(source) {
  const text = String(source || "");
  // Token positions exclude comments and string interiors while retaining original offsets.
  const tokenAt = new Map(tokenize(text).map((token) => [token.start, token]));
  const blocks = Array.from(text.matchAll(/^[ \t]*(model|enum)[ \t]+([A-Za-z]\w*)[ \t]*\{([^}]*)\}/gm))
    .filter((block) => tokenAt.get(block.index + block[0].indexOf(block[1]))?.type === "name");
  const enums = new Map();
  for (const block of blocks.filter((candidate) => candidate[1] === "enum")) {
    enums.set(block[2], Array.from(block[3].matchAll(/^[ \t]*([A-Za-z]\w*)/gm), (match) => match[1]));
  }
  const fieldRules = [];
  const models = blocks.filter((candidate) => candidate[1] === "model").map((block) => {
    const bodyStart = block.index + block[0].indexOf("{") + 1;
    const mapping = Array.from(block[3].matchAll(/@@map\s*\(\s*"([^"]+)"\s*\)/g))
      .find((match) => tokenAt.get(bodyStart + match.index)?.value === "@");
    return { name: block[2], collection: mapping ? mapping[1] : null, at: block.index };
  });
  for (const block of blocks.filter((candidate) => candidate[1] === "model")) {
    const bodyStart = block.index + block[0].indexOf("{") + 1;
    for (const line of block[3].matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]+([A-Za-z]\w*)(\[\]|\?)?(?=[ \t]|$)([^\n]*)$/gm)) {
      const [declaration, name, type, modifier, rest] = line;
      if (!PRISMA_SCALARS.has(type) && !enums.has(type)) continue;
      const constraints = [`type: ${type}${modifier === "[]" ? "[]" : ""}`];
      if (modifier === "?") constraints.push("optional");
      if (enums.has(type)) constraints.push(`enum: [${enums.get(type).join(", ")}]`);
      const attributes = rest.replace(/\/\/.*$/, "").trim();
      if (attributes) constraints.push(attributes);
      fieldRules.push({ field: name, model: block[2], at: bodyStart + line.index + declaration.indexOf(name), constraints });
    }
  }
  return { fieldRules, validators: [], models };
}

module.exports = { tokenize, inspectSource, inspectSourceDetailed, inspectMongooseSchemas, inspectPrismaSchema };
