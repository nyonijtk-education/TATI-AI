// api/chat.js - Streaming Vercel Serverless / Edge Function Proxy for Tati Voice AI

export const config = {
  runtime: 'edge', // Edge runtime for ultra-low latency streaming without serverless response buffering
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Bypass-Tunnel-Reminder",
};

export default async function handler(req) {
  // 1. CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // 2. Validate Method
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 3. Parse Request Payload
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const query = (body.prompt || body.transcript || "").trim();
  const language = body.language || "en-US";
  const backendUrl = (process.env.LOCAL_BACKEND_URL || "").replace(/\/$/, "");

  if (!query) {
    return new Response(JSON.stringify({ error: "Query text is required." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 4. PRIMARY: Local Backend via Tunnel (Streaming with 30s Connection Timeout)
  if (backendUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s processing window for local Ollama

      const localResponse = await fetch(`${backendUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Bypass-Tunnel-Reminder": "true"
        },
        body: JSON.stringify({
          prompt: query,
          transcript: query,
          language: language,
          stream: true
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (localResponse.ok && localResponse.body) {
        const contentType = localResponse.headers.get("content-type") || "";

        // Streaming text response from local Ollama backend
        if (contentType.includes("text/event-stream") || contentType.includes("text/plain") || contentType.includes("application/x-ndjson")) {
          return new Response(localResponse.body, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "X-Response-Provider": "ollama_local_stream"
            }
          });
        }

        // Non-streaming JSON response from local Ollama backend
        const localData = await localResponse.json();
        const responseText = localData.response_text || localData.response || localData.reply || "";

        if (responseText.trim()) {
          return new Response(JSON.stringify({
            response_text: responseText,
            database_hits: localData.database_hits || 0,
            hits: localData.hits || [],
            provider: localData.provider || "ollama_local"
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      } else {
        console.warn(`⚠️ Tunnel HTTP ${localResponse.status}. Triggering Groq Cloud stream fallback...`);
      }
    } catch (err) {
      console.warn(`⚠️ Local Ollama backend offline/timeout: ${err.message}. Triggering Groq Cloud stream fallback...`);
    }
  }

  // 5. FALLBACK: Groq Cloud LPU Engine (~120ms TTFT Token Streaming with valid Model ID & key sanitization)
  let apiKey = (process.env.GROQ_API_KEY || process.env.NEXT_PUBLIC_GROQ_API_KEY || "").trim();
  apiKey = apiKey.replace(/^["']|["']$/g, ''); // Strip surrounding quotes if pasted into Vercel env

  if (!apiKey) {
    return new Response(JSON.stringify({
      error: "Local backend offline/timed out and GROQ_API_KEY missing from Vercel environment."
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are Tati Voice AI, a fast and empathetic assistant. Answer concisely in exactly 2 clear, warm sentences."
          },
          { role: "user", content: query }
        ],
        max_tokens: 150,
        temperature: 0.4,
        stream: true
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text().catch(() => "");
      return new Response(JSON.stringify({
        error: `Groq API Error (${groqResponse.status}): ${errText}`
      }), {
        status: groqResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Transform OpenAI SSE format (`data: {"choices":[{"delta":{"content":"..."}}]}`) into raw text stream
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                controller.enqueue(encoder.encode(content));
              }
            } catch (e) {
              // Ignore partial JSON chunks
            }
          }
        }
      }
    });

    return new Response(groqResponse.body.pipeThrough(transformStream), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Response-Provider": "groq_vercel_cloud"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: `Groq Cloud Fallback Failure: ${err.message}`
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}