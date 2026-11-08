# Tati Voice AI Platform

Tati is an interactive, sub-second latency voice AI research engine powered by Gemini Flash with live Google Search Grounding and web-based audio visualization.

## Opening in Visual Studio Code

### Method 1: Live Server Extension (Recommended)
1. Open this folder in **VS Code**.
2. Install the **Live Server** extension (`ms-vscode.live-server`).
3. Right-click `index.html` and select **"Open with Live Server"**.

### Method 2: Command Line Local Server
Open terminal in the project directory:
```bash
# Using Node.js
npx serve .

# Or using Python
python3 -m http.server 8000
```

## Setup & API Key
Click the **Audio & Voice Settings** gear icon in the top right to configure your **Gemini API Key** (`AIzaSy...`). The key is saved securely in your browser's local storage.
