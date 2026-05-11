// Edge Function: translate-chat
// Server-side proxy for chat translation. Browser sends {text, fromLang, toLang},
// function calls Anthropic Haiku with the server-held ANTHROPIC_API_KEY, and
// returns {translated}. Replaces the previous direct-browser-Anthropic path that
// required every device to have an API key in localStorage.
//
// Deploy:
//   supabase functions deploy translate-chat --project-ref wymoezilyjmyibmuqqmr
//
// Required secret (set once via dashboard or CLI):
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Auth: requires a valid Supabase JWT — translation isn't sensitive but we don't
// want anonymous traffic burning the API key. CORS open for browser fetch.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  cv: "Cape Verdean Kriolu",
  ko: "Korean",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Auth gate — must be a signed-in user.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerData.user) return json(401, { error: "Invalid JWT" });

  // Parse payload.
  let body: { text?: string; fromLang?: string; toLang?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const text = (body.text || "").toString();
  const fromLang = (body.fromLang || "en").toString();
  const toLang = (body.toLang || "en").toString();
  if (!text) return json(400, { error: "Missing text" });

  // Same-language shortcut.
  if (fromLang === toLang) return json(200, { translated: text });

  if (!ANTHROPIC_API_KEY) return json(500, { error: "Server missing ANTHROPIC_API_KEY" });

  // Call Anthropic Haiku — fast + cheap, plenty for short chat messages.
  const prompt =
    `Translate this short workplace chat message from ${LANG_NAMES[fromLang] || fromLang} to ${LANG_NAMES[toLang] || toLang}. ` +
    `Reply with ONLY the translation, no quotes, no commentary.\n\n${text}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return json(502, { error: "Anthropic API error", status: resp.status, detail: errText });
    }
    const data = await resp.json();
    const translated = (data?.content?.[0]?.text || "").trim();
    if (!translated) return json(502, { error: "Anthropic returned empty translation" });
    return json(200, { translated });
  } catch (e) {
    return json(500, { error: "Translation call failed", detail: (e as Error).message });
  }
});
