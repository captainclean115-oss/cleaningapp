#!/usr/bin/env python3
"""Schedule-revenue-total fix -- PART 3. Rewires every other revenue
surface found in the audit to the ONE shared _pentaResolveJobPrice
resolver (added in edit_srt01) instead of its own duplicated copy of
the now-dead CLIENT_PRICES/REV_LOOKUP fallback chain:
- the Schedule tab's per-team tile subtotal (inline calc in renderCal)
- the Team Assignments tile stats (_teamDayStats)
- Claire's revenue_summary and team_performance tools
- Close Day's per-team preview (which never even had a fallback at
  all -- parseFloat(j.price)||0 straight, so a missing-price job there
  silently contributed $0 same as the original bug, with no fallback
  attempt whatsoever).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_RENDERCAL_TILE = """        var teamRev = teamJobs.filter(function(j){ return !j.cancelled; }).reduce(function(sum,j){
          var p = 0;
          if (j.price) { p = parseFloat(j.price)||0; }
          else {
            var cl = PentaClients.getClient(j.clientId);
            if (cl) { var cp = CLIENT_PRICES[cl.ln.toLowerCase().replace(/[^a-z \\-]/g,'').trim()]; if(cp) p=parseFloat(cp.replace('$',''))||0; }
          }
          return sum+p;
        },0);"""

NEW_RENDERCAL_TILE = """        var teamRev = teamJobs.filter(function(j){ return !j.cancelled; }).reduce(function(sum,j){
          return sum + _pentaResolveJobPrice(j).amount;
        },0);"""

OLD_TEAM_DAY_STATS = """  var revenue = 0, mins = 0;
  dayJobs.forEach(function(j){
    var price = 0;
    if (j.price) {
      price = parseFloat(j.price) || 0;
    } else if (typeof PentaClients !== 'undefined' && PentaClients.getClient) {
      var c = PentaClients.getClient(j.clientId);
      if (c && c.ln) {
        var ln = c.ln.toLowerCase().replace(/[^a-z \\-]/g,'').trim();
        var cp = (typeof CLIENT_PRICES !== 'undefined') ? CLIENT_PRICES[ln] : null;
        if (cp) price = parseFloat(String(cp).replace('$','')) || 0;
      }
      if (!price && typeof REV_LOOKUP !== 'undefined') price = REV_LOOKUP[j.clientId] || 0;
    }
    revenue += price;
    try { mins += getJobDurationMins(j); } catch (e) {}
  });
  return { houses: dayJobs.length, revenue: revenue, mins: mins };"""

NEW_TEAM_DAY_STATS = """  var revenue = 0, mins = 0;
  dayJobs.forEach(function(j){
    revenue += _pentaResolveJobPrice(j).amount;
    try { mins += getJobDurationMins(j); } catch (e) {}
  });
  return { houses: dayJobs.length, revenue: revenue, mins: mins };"""

OLD_RS_PRICE = """    function _rsPrice(j){
      if (j.price) return parseFloat(j.price)||0;
      var cc = PentaClients.getClient(j.clientId);
      if (cc) {
        var ln = cc.ln.toLowerCase().replace(/[^a-z \\-]/g,'').trim();
        var cp = CLIENT_PRICES[ln];
        if (cp) return parseFloat(cp.replace('$',''))||0;
      }
      return REV_LOOKUP[j.clientId] || 0;
    }"""

NEW_RS_PRICE = """    function _rsPrice(j){
      return _pentaResolveJobPrice(j).amount;
    }"""

OLD_TP_PRICE = """    function _tpPrice(j){
      if (j.price) return parseFloat(j.price)||0;
      var cc = PentaClients.getClient(j.clientId);
      if (cc) { var ln=cc.ln.toLowerCase().replace(/[^a-z \\-]/g,'').trim(); var cp=CLIENT_PRICES[ln]; if (cp) return parseFloat(cp.replace('$',''))||0; }
      return REV_LOOKUP[j.clientId] || 0;
    }"""

NEW_TP_PRICE = """    function _tpPrice(j){
      return _pentaResolveJobPrice(j).amount;
    }"""

OLD_CLOSE_DAY_REVENUE = """  var revenueCents = allTeamJobs.reduce(function (s, j) { return s + Math.round((parseFloat(j.price) || 0) * 100); }, 0);"""

NEW_CLOSE_DAY_REVENUE = """  // Schedule-revenue-total fix: was a bare parseFloat(j.price)||0 with
  // no fallback at all -- a job missing its price contributed $0 here
  // too, same bug as the Schedule tab's total. Now uses the same
  // shared resolver (job.price, else the client's real current price).
  var revenueCents = allTeamJobs.reduce(function (s, j) { return s + Math.round(_pentaResolveJobPrice(j).amount * 100); }, 0);"""

EDITS = [
    ("Schedule-revenue-total fix: renderCal's per-team tile uses the shared resolver", OLD_RENDERCAL_TILE, NEW_RENDERCAL_TILE),
    ("Schedule-revenue-total fix: _teamDayStats uses the shared resolver", OLD_TEAM_DAY_STATS, NEW_TEAM_DAY_STATS),
    ("Schedule-revenue-total fix: Claire's revenue_summary uses the shared resolver", OLD_RS_PRICE, NEW_RS_PRICE),
    ("Schedule-revenue-total fix: Claire's team_performance uses the shared resolver", OLD_TP_PRICE, NEW_TP_PRICE),
    ("Schedule-revenue-total fix: Close Day's preview uses the shared resolver", OLD_CLOSE_DAY_REVENUE, NEW_CLOSE_DAY_REVENUE),
]

if __name__ == "__main__":
    apply_edits(EDITS)
