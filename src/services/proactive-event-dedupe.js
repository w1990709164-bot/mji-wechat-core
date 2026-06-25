"use strict";

function buildProactiveEventDedupeKey(input = {}) {
  const eventAt = input.eventAt instanceof Date
    ? input.eventAt
    : new Date(input.eventAt);
  if (Number.isNaN(eventAt.getTime())) {
    throw new Error("eventAt must be valid");
  }

  const bucketMs = 15 * 60 * 1000;
  const bucket = new Date(
    Math.floor(eventAt.getTime() / bucketMs) * bucketMs
  ).toISOString();
  const sourceText = normalizeComparableText(input.sourceText);
  const encodedSource = Buffer.from(sourceText, "utf8")
    .toString("base64url")
    .slice(0, 120);

  return [
    "event",
    normalizeText(input.userId),
    normalizeText(input.userCharacterId),
    normalizeText(input.eventType),
    bucket,
    encodedSource,
  ].join(":");
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[，。！？、,.!?\s]+/g, "")
    .trim()
    .toLowerCase();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildProactiveEventDedupeKey,
  normalizeComparableText,
};
