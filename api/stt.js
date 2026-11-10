// api/stt.js - Proxy for Faster-Whisper Audio Transcription

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
  const contentType = req.headers.get("content-type") || "";

  try {
    const response = await fetch(`${backendUrl}/api/stt`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Bypass-Tunnel-Reminder": "true"
      },
      body: req.body
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `STT Proxy Error: ${err.message}` }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}