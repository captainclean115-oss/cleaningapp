#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 5 audit fix.

edit_client/change_price/update_client_notes resolved their target via
findClient() -- first-match-wins, NOT ambiguity-safe. Now that
_claireDispatchOrPropose resolves these ambiguity-safely BEFORE the
proposal exists and stores _resolvedClientId, the executor must use
THAT id -- otherwise the card could name the correct client while the
write silently landed on a different same-named one. The old lookup is
kept only as a defensive fallback for a call that somehow skipped
resolution.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """  } else if (name === 'edit_client') {
    var ecClient = findClient(input.client);
    if (!ecClient) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'Couldn\\'t find that client.'); return; }"""

NEW1 = """  } else if (name === 'edit_client') {
    var ecClient = (input._resolvedClientId && PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
    if (!ecClient) ecClient = findClient(input.client);
    if (!ecClient) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'Couldn\\'t find that client.'); return; }"""

OLD2 = """  } else if (name === 'change_price') {
    var cpClient = findClient(input.client);
    if (!cpClient) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'Couldn\\'t find that client.'); return; }"""

NEW2 = """  } else if (name === 'change_price') {
    var cpClient = (input._resolvedClientId && PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
    if (!cpClient) cpClient = findClient(input.client);
    if (!cpClient) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'Couldn\\'t find that client.'); return; }"""

OLD3 = """  } else if (name === 'update_client_notes') {
    var nClient = findClient(input.client);
    if (!nClient) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'I couldn\\'t find that client.'); return; }"""

NEW3 = """  } else if (name === 'update_client_notes') {
    var nClient = (input._resolvedClientId && PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
    if (!nClient) nClient = findClient(input.client);
    if (!nClient) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'I couldn\\'t find that client.'); return; }"""

EDITS = [
    ("Claire proposal-resolve-verify: edit_client uses resolved client id", OLD1, NEW1),
    ("Claire proposal-resolve-verify: change_price uses resolved client id", OLD2, NEW2),
    ("Claire proposal-resolve-verify: update_client_notes uses resolved client id", OLD3, NEW3),
]

if __name__ == "__main__":
    apply_edits(EDITS)
