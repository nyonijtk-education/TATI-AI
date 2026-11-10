// api/tts.js - Vercel Edge Proxy for Local Kokoro TTS Engine

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

  const backendUrl = (process.env.LOCAL_BACKEND_URL || "").replace(/\/$/, "");

  if (!backendUrl) {
    return new Response(JSON.stringify({ error: "LOCAL_BACKEND_URL is not set on Vercel environment." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const text = (body.text || "").trim();

    if (!text) {
      return new Response(JSON.stringify({ error: "Text payload is required for TTS." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const localResponse = await fetch(`${backendUrl}/api/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Bypass-Tunnel-Reminder": "true"
      },
      body: JSON.stringify({
        text: text,
        voice: body.voice || "af_heart",
        speed: body.speed || 1.0
      })
    });

    if (!localResponse.ok) {
      const errText = await localResponse.text().catch(() => "");
      console.error(`Local Kokoro TTS Backend returned HTTP ${localResponse.status}: ${errText}`);
      return new Response(JSON.stringify({
        error: `Kokoro TTS Local Engine HTTP ${localResponse.status}`,
        details: errText
      }), {
        status: localResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const audioBuffer = await localResponse.arrayBuffer();

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": localResponse.headers.get("content-type") || "audio/wav",
        "Content-Length": audioBuffer.byteLength.toString(),
        "Cache-Control": "no-cache"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: `TTS Proxy Exception: ${err.message}` }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}