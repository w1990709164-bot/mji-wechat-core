"use strict";

const { extractProactiveEvents: extractBaseEvents } = require("./proactive-event-extractor");

function extractProactiveEvents(input = {}) {
  const originalText = typeof input.text === "string" ? input.text.trim() : "";
  const normalizedText = normalizeTemporalCounters(originalText);
  const events = extractBaseEvents({
    ...input,
    text: normalizedText,
  });
  return events.map((event) => ({
    ...event,
    description: originalText,
    metadata: {
      ...(event.metadata || {}),
      sourceText: originalText,
      normalizedSourceText: normalizedText,
    },
  }));
}

function normalizeTemporalCounters(value) {
  return String(value || "").replace(
    /([零一二两三四五六七八九十百\d]+(?:\.\d+)?)\s*个\s*(分钟|小时|天)后/g,
    "$1$2后"
  );
}

module.exports = {
  extractProactiveEvents,
  normalizeTemporalCounters,
};
