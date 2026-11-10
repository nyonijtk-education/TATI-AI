// api/tts.js - Proxy for Kokoro-82M Neural Audio Synthesis

export const config = {
  runtime: 'edge',
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Bypass-Tunnel-Reminder",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const backendUrl = (process.env.LOCAL_BACKEND_URL || "https://tati-voice-ai-backend.loca.lt").replace(/\/$/, "");

  try {
    const body = await req.json();

    const response = await fetch(`${backendUrl}/api/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Bypass-Tunnel-Reminder": "true"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: "Kokoro TTS backend error" }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/wav",
        "Cache-Control": "no-cache"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `TTS Proxy Error: ${err.message}` }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}