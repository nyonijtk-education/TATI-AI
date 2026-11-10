module.exports = {
  apps: [
    {
      name: "tati-backend",
      cwd: "/Users/nyoni/Tati Voice AI Platform",
      script: ".venv/bin/uvicorn",
      args: "main:app --host 127.0.0.1 --port 8000",
      interpreter: "none",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "tati-localtunnel",
      cwd: "/Users/nyoni/Tati Voice AI Platform",
      script: "npx",
      args: "localtunnel --port 8000 --subdomain tati-voice-ai-backend",
      autorestart: true,
      restart_delay: 5000,
    },
    {
      name: "tati-meilisearch",
      script: "meilisearch",
      autorestart: true,
    },
    {
      name: "tati-ollama",
      script: "ollama",
      args: "serve",
      autorestart: true,
    }
  ]
};