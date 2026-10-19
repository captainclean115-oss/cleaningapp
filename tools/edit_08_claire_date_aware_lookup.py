#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Claire's name resolution.
findEmployees/findEmployeeWithSuggestions get an optional asOfDate,
threaded straight to getUnifiedRoster's own existing contract. Omitted
(undefined) -> bare call, byte-for-byte the same behavior as before
this fix (per spec: "with no date, keep today's behavior").
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "findEmployees: optional asOfDate param, threaded to getUnifiedRoster",
        """function findEmployees(query) {
  if (!query) return [];
  var q = _cleanName(query);
  if (!q) return [];
  var tokens = q.split(/\\s+/).filter(Boolean);
  var scored = [];
  getUnifiedRoster().forEach(function(e) {""",
        """function findEmployees(query, asOfDate) {
  if (!query) return [];
  var q = _cleanName(query);
  if (!q) return [];
  var tokens = q.split(/\\s+/).filter(Boolean);
  var scored = [];
  getUnifiedRoster(asOfDate).forEach(function(e) {""",
    ),
    (
        "findEmployeeWithSuggestions: optional asOfDate param, threaded through",
        """function findEmployeeWithSuggestions(query) {
  var matches = findEmployees(query);
  if (matches.length) return { matches: matches, suggestions: [] };
  var q = _cleanName(query);
  if (!q) return { matches: [], suggestions: [] };
  var all = [];
  getUnifiedRoster().forEach(function(e) {""",
        """function findEmployeeWithSuggestions(query, asOfDate) {
  var matches = findEmployees(query, asOfDate);
  if (matches.length) return { matches: matches, suggestions: [] };
  var q = _cleanName(query);
  if (!q) return { matches: [], suggestions: [] };
  var all = [];
  getUnifiedRoster(asOfDate).forEach(function(e) {""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
