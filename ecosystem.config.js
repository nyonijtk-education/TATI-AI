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
      name: "tati-cloudflared",
      cwd: "/Users/nyoni/Tati Voice AI Platform",
      script: "cloudflared",
      args: "tunnel --url http://127.0.0.1:8000",
      interpreter: "none",
      autorestart: true,
      restart_delay: 3000,
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