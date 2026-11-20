"use strict";

module.exports = function createCostObservations(deps = {}) {
  const { fail, readGovernanceEventLog, recordCost, collectCostObservations, readModelPrices } = deps;
  const COST_EVENT_TYPE = "cost.observed";
  const LEGAL_COST_PHASES = new Set(["start", "plan", "implement", "review", "land"]);
  const DISPATCH_COST_PHASES = new Set(["plan", "implement", "review"]);
  const LEGAL_USAGE_SCOPES = new Set(["phase_delta", "execution_cumulative", "combined_only"]);
  const LEGAL_MEASUREMENT_SOURCES = new Set(["provider_reported", "explicit_measurement", "lifecycle_boundary"]);

  // Compare the caller's attributed observation, not mutable pricing output.
  // A rate-card update may change or resolve derived USD between deliveries;
  // the first journalled cost remains authoritative for replay while the
  // normalized usage payload still rejects changed measurements.
  function canonicalDispatchObservationInput(value) {
    const semantic = {
      ticket: value.ticket,
      agent: value.agent,
      model: value.model,
      input_tokens: value.input_tokens,
      output_tokens: value.output_tokens,
      phase: value.phase,
      measurement_status: value.measurement_status,
      measurement_source: value.measurement_source,
      usage_scope: value.usage_scope,
      dispatch_execution_id: value.dispatch_execution_id,
      attempt_id: value.attempt_id,
      ...(value.unknown_reason ? { unknown_reason: value.unknown_reason } : {}),
      ...(value.usd_provenance === "explicit_measurement" ? { explicit_usd: value.usd } : {}),
    };
    return JSON.stringify(semantic, Object.keys(semantic).sort());
  }

  function dispatchObservationKey(executionId, phase, attemptId) {
    return `${executionId}\u0000${phase}\u0000${attemptId}`;
  }

  function validateStableCostId(flag, value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      fail(`${flag} must be 1-128 safe identifier characters (letters, digits, dot, underscore, colon, hyphen).`);
    }
    return value;
  }

  function findDispatchObservation(observations, executionId, phase, attemptId) {
    return observations.find((observation) =>
      observation.dispatch_execution_id === executionId &&
      observation.phase === phase &&
      observation.attempt_id === attemptId
    ) || null;
  }

  function parseNonNegativeInteger(flag, value) {
    if (value === undefined || value === null || value === "") fail(`${flag} requires a non-negative integer value.`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) fail(`${flag} must be a non-negative integer (got "${value}").`);
    return number;
  }

  function isLegalCostPhase(phase) { return LEGAL_COST_PHASES.has(phase); }
  function isDispatchCostPhase(phase) { return DISPATCH_COST_PHASES.has(phase); }
  function isLegalUsageScope(scope) { return LEGAL_USAGE_SCOPES.has(scope); }
  function isLegalMeasurementSource(source) { return LEGAL_MEASUREMENT_SOURCES.has(source); }

  function priceAttributedUsage(model, inputTokens, outputTokens) {
    let match = null;
    try {
      const want = String(model || "").trim().toLowerCase();
      const prices = want ? readModelPrices() : null;
      const models = prices?.models;
      if (models && typeof models === "object" && !Array.isArray(models)) {
        let exact = null;
        let bestPrefix = null;
        for (const [key, rate] of Object.entries(models)) {
          const lowered = String(key).toLowerCase();
          if (lowered === want) {
            exact = { rate, matched: key };
            break;
          }
          if (want && (want.startsWith(lowered) || lowered.startsWith(want)) &&
              (!bestPrefix || lowered.length > String(bestPrefix.matched).length)) {
            bestPrefix = { rate, matched: key };
          }
        }
        match = exact || bestPrefix;
      }
    } catch {
      // Invalid or unreadable rate evidence must not erase valid usage data.
      match = null;
    }
    const rates = match?.rate;
    if (!match || !rates || typeof rates !== "object" ||
        typeof rates.input !== "number" || !Number.isFinite(rates.input) || rates.input < 0 ||
        typeof rates.output !== "number" || !Number.isFinite(rates.output) || rates.output < 0) {
      return { usd: null, estimated: false, pricedBy: null, provenance: "unavailable", unknownReason: model ? "documented_model_rate_unavailable" : "model_unattributed" };
    }
    return {
      usd: Math.round(((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output) * 1e6) / 1e6,
      estimated: true,
      pricedBy: match.matched,
      provenance: "documented_rate_card",
      unknownReason: null,
    };
  }

  function findDispatchBinding(journal, ticketId) {
    let startIndex = -1;
    let executionId = null;
    let startEvent = null;
    for (let index = 0; index < journal.length; index += 1) {
      const event = journal[index];
      if (event?.ticket === ticketId && event.command === "start" && event.result === "succeeded" && event.details?.dispatch_execution_id) {
        startIndex = index;
        executionId = event.details.dispatch_execution_id;
        startEvent = event;
      }
    }
    return { startIndex, executionId, startEvent };
  }

  function findBoundaryEvent(journal, ticketId, phase, commands, binding) {
    if (phase === "plan") return binding.startEvent;
    let boundary = null;
    for (let index = binding.startIndex + 1; index < journal.length; index += 1) {
      const event = journal[index];
      if (event?.ticket === ticketId && event.result === "succeeded" && commands.includes(event.command)) boundary = event;
    }
    return boundary;
  }

  function recordLifecycleCostBoundary(ticketId, phase, eventCommands) {
    try {
      const journal = readGovernanceEventLog();
      const binding = findDispatchBinding(journal, ticketId);
      if (!binding.executionId) return;
      const boundaryEvent = findBoundaryEvent(journal, ticketId, phase, eventCommands, binding);
      if (!boundaryEvent) return;
      const originalLog = console.log;
      console.log = () => {};
      try {
        recordCost(ticketId, {
          dispatchExecutionId: binding.executionId,
          attemptId: `boundary:${phase}:${boundaryEvent.ts}`,
          phase,
          measurementSource: "lifecycle_boundary",
          usageScope: "phase_delta",
          unknownReason: "provider_usage_unavailable_at_lifecycle_boundary",
        });
      } finally {
        console.log = originalLog;
      }
    } catch (error) {
      console.warn(`Cost observation advisory failed for ${ticketId}/${phase}: ${error?.message || String(error)}`);
    }
  }

  function aggregateCost(observations, dimension) {
    const buckets = new Map();
    for (const obs of observations) {
      const key = bucketKey(obs, dimension);
      if (!buckets.has(key)) {
        buckets.set(key, createCostBucket(key));
      }
      addObservationToBucket(buckets.get(key), obs);
    }
    return [...buckets.keys()].sort().map((key) => {
      const bucket = buckets.get(key);
      return { ...bucket, usd: bucket.usd === null ? null : Math.round(bucket.usd * 1e6) / 1e6 };
    });
  }

  function bucketKey(observation, dimension) {
    if (dimension === "agent") return observation.agent || "(unattributed)";
    if (dimension === "model") return observation.model || "(unknown)";
    if (dimension === "phase") return observation.phase || "(unspecified)";
    return observation.ticket || "(none)";
  }

  function createCostBucket(key) {
    return {
      key, observations: 0, measured_observations: 0, unknown_observations: 0,
      partial_observations: 0, unknown_input_observations: 0,
      unknown_output_observations: 0, non_delta_observations: 0,
      provenance: {
        measurement_sources: {}, usd_provenance: {}, priced_by: {},
        unknown_reasons: {}, usd_unknown_reasons: {}, usage_scopes: {},
      },
      input_tokens: null, output_tokens: null, usd: null,
    };
  }

  function incrementProvenance(bucket, key, value) {
    const label = typeof value === "string" && value.length > 0 ? value : "(unspecified)";
    incrementCount(bucket.provenance[key], label, 1);
  }

  function incrementCount(counts, key, amount) {
    const current = Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : 0;
    Object.defineProperty(counts, key, {
      value: current + amount,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  function formatCounts(counts) {
    const entries = Object.keys(counts).sort().map((key) => [key, counts[key]]);
    return entries.length ? entries.map(([key, count]) => `${key}=${count}`).join(", ") : "none";
  }

  function formatCoverage(bucket) {
    const provenance = bucket.provenance;
    return `coverage ${bucket.measured_observations} measured/${bucket.partial_observations} partial/${bucket.unknown_observations} unknown; ` +
      `source ${formatCounts(provenance.measurement_sources)}; USD ${formatCounts(provenance.usd_provenance)}; ` +
      `priced by ${formatCounts(provenance.priced_by)}; unknown ${formatCounts(provenance.unknown_reasons)}; ` +
      `USD unknown ${formatCounts(provenance.usd_unknown_reasons)}`;
  }

  function addKnownValue(bucket, observation, field) {
    if (observation[field] == null) return;
    bucket[field] = (bucket[field] || 0) + Number(observation[field]);
  }

  function addObservationToBucket(bucket, observation) {
    bucket.observations += 1;
    const unknown = observation.measurement_status === "unknown" || (observation.input_tokens == null && observation.output_tokens == null);
    const partial = observation.measurement_status === "partial" || observation.input_tokens == null || observation.output_tokens == null;
    incrementProvenance(bucket, "measurement_sources", observation.measurement_source);
    incrementProvenance(bucket, "usd_provenance", observation.usd_provenance);
    incrementProvenance(bucket, "usage_scopes", observation.usage_scope || "phase_delta");
    if (observation.priced_by) incrementProvenance(bucket, "priced_by", observation.priced_by);
    if (observation.unknown_reason || unknown || partial) {
      incrementProvenance(bucket, "unknown_reasons", observation.unknown_reason);
    }
    if (observation.usd == null) incrementProvenance(bucket, "usd_unknown_reasons", observation.usd_unknown_reason);
    if (unknown) bucket.unknown_observations += 1;
    else if (partial) bucket.partial_observations += 1;
    else bucket.measured_observations += 1;
    if (observation.input_tokens == null) bucket.unknown_input_observations += 1;
    if (observation.output_tokens == null) bucket.unknown_output_observations += 1;
    if (observation.usage_scope && observation.usage_scope !== "phase_delta") {
      bucket.non_delta_observations += 1;
      return;
    }
    for (const field of ["input_tokens", "output_tokens", "usd"]) addKnownValue(bucket, observation, field);
  }

  function costReport(options = {}) {
    const dimension = options.by || "ticket";
    if (!["ticket", "agent", "model", "phase"].includes(dimension)) fail("cost --by must be one of ticket|agent|model|phase.");
    const observations = collectCostObservations(options.ticket || null);
    const totals = aggregateCost(observations, "ticket").reduce((acc, bucket) => {
      for (const field of ["observations", "measured_observations", "unknown_observations", "partial_observations", "unknown_input_observations", "unknown_output_observations", "non_delta_observations"]) {
        acc[field] += bucket[field];
      }
      for (const [category, counts] of Object.entries(bucket.provenance)) {
        for (const [value, count] of Object.entries(counts)) {
          incrementCount(acc.provenance[category], value, count);
        }
      }
      for (const field of ["input_tokens", "output_tokens", "usd"]) {
        if (bucket[field] !== null) acc[field] = (acc[field] || 0) + bucket[field];
      }
      return acc;
    }, {
      observations: 0, measured_observations: 0, unknown_observations: 0,
      partial_observations: 0, unknown_input_observations: 0,
      unknown_output_observations: 0, non_delta_observations: 0,
      provenance: {
        measurement_sources: {}, usd_provenance: {}, priced_by: {},
        unknown_reasons: {}, usd_unknown_reasons: {}, usage_scopes: {},
      },
      input_tokens: null, output_tokens: null, usd: null,
    });
    if (totals.usd !== null) totals.usd = Math.round(totals.usd * 1e6) / 1e6;
    const nonDelta = observations.filter((obs) => obs.usage_scope && obs.usage_scope !== "phase_delta");
    const scopeTotals = {};
    for (const scope of ["execution_cumulative", "combined_only"]) {
      const latestByExecution = new Map();
      for (const observation of nonDelta.filter((entry) => entry.usage_scope === scope)) {
        const execution = observation.dispatch_execution_id || `legacy:${observation.ticket}:${observation.phase || "unknown"}`;
        const prior = latestByExecution.get(execution);
        if (!prior || String(observation._observed_at || "") >= String(prior._observed_at || "")) latestByExecution.set(execution, observation);
      }
      const selected = [...latestByExecution.values()];
      const sumKnown = (field) => {
        const known = selected.map((entry) => entry[field]).filter((value) => value !== null && value !== undefined);
        return known.length ? known.reduce((sum, value) => sum + Number(value), 0) : null;
      };
      scopeTotals[scope] = {
        observations: selected.length, executions: selected.length,
        measured_observations: selected.filter((entry) => entry.measurement_status === "measured").length,
        partial_observations: selected.filter((entry) => entry.measurement_status === "partial").length,
        unknown_observations: selected.filter((entry) => entry.measurement_status === "unknown").length,
        unknown_input_observations: selected.filter((entry) => entry.input_tokens == null).length,
        unknown_output_observations: selected.filter((entry) => entry.output_tokens == null).length,
        input_tokens: sumKnown("input_tokens"), output_tokens: sumKnown("output_tokens"), usd: sumKnown("usd"),
        note: scope === "execution_cumulative"
          ? "latest cumulative snapshot per execution; not added to phase-delta totals"
          : "combined-only measurements remain unallocated; not added to phase-delta totals",
      };
      if (scopeTotals[scope].usd !== null) scopeTotals[scope].usd = Math.round(scopeTotals[scope].usd * 1e6) / 1e6;
    }
    const payload = { by: dimension, ticket_filter: options.ticket || null, totals, scope_totals: scopeTotals, breakdown: aggregateCost(observations, dimension) };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    console.log(`Cost ledger (by ${dimension}${options.ticket ? `, ticket=${options.ticket}` : ""})`);
    console.log(`Totals: ${totals.observations} observation(s), ${totals.input_tokens === null ? "unknown" : totals.input_tokens} in + ${totals.output_tokens === null ? "unknown" : totals.output_tokens} out tokens, ${totals.usd === null ? "unknown" : `$${totals.usd.toFixed(6)}`}`);
    console.log(`  ${formatCoverage(totals)}`);
    if (!payload.breakdown.length) console.log("  (empty ledger)");
    else for (const bucket of payload.breakdown) {
      console.log(`  ${bucket.key}: ${bucket.observations} obs, ${bucket.input_tokens === null ? "unknown" : bucket.input_tokens} in / ${bucket.output_tokens === null ? "unknown" : bucket.output_tokens} out, ${bucket.usd === null ? "unknown" : `$${bucket.usd.toFixed(6)}`}; ${formatCoverage(bucket)}`);
    }
    return payload;
  }

  return {
    COST_EVENT_TYPE,
    legalCostPhases: Object.freeze([...LEGAL_COST_PHASES]),
    legalUsageScopes: Object.freeze([...LEGAL_USAGE_SCOPES]),
    legalMeasurementSources: Object.freeze([...LEGAL_MEASUREMENT_SOURCES]),
    isLegalCostPhase, isDispatchCostPhase, isLegalUsageScope, isLegalMeasurementSource,
    canonicalDispatchObservationInput, dispatchObservationKey, validateStableCostId,
    findDispatchObservation, parseNonNegativeInteger, priceAttributedUsage,
    recordLifecycleCostBoundary, aggregateCost, costReport,
  };
};
