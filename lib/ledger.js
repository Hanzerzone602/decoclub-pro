"use strict";
// Append-only credit ledger: one row per credit change.
const crypto = require("crypto");
const SOURCES = ["square", "admin", "free"];

function rows(db) {
  if (!Array.isArray(db.credit_ledger)) db.credit_ledger = [];
  return db.credit_ledger;
}

function recordCredit(db, row) {
  if (!db || !row || !row.user_id) return null;
  const r = {
    id: crypto.randomBytes(8).toString("hex"),
    user_id: String(row.user_id),
    service: row.service === "halftones" ? "halftones" : "vectorize",
    delta: Math.trunc(Number(row.delta) || 0),
    balance: row.balance == null ? null : Number(row.balance),
    source: SOURCES.indexOf(row.source) !== -1 ? row.source : "admin",
    admin_id: row.admin_id || null,
    reason: row.reason ? String(row.reason).slice(0, 300) : "",
    ref: row.ref || null,
    at: new Date().toISOString(),
  };
  rows(db).push(r);
  if (rows(db).length > 20000) rows(db).splice(0, rows(db).length - 20000);
  return r;
}

function historyFor(db, userId, limit) {
  return rows(db).filter((r) => r.user_id === userId).slice(-(limit || 200)).reverse();
}

module.exports = { recordCredit, historyFor, SOURCES };
