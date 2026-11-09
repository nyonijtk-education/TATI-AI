// Complete production-ready chat.js for Tati Voice AI Platform
const BACKEND_URL = 'https://tati-voice-ai-backend.loca.lt';

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let recognition = null;
let isProcessing = false;

// 1. iOS / Safari Audio Context Unlocker
function unlockIOSAudio() {
    if (!audioCtx) {
        audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    try {
        const buffer = audioCtx.createBuffer(1, 1, 22050);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } catch (e) {
        console.log("Audio unlock buffer execution:", e);
    }
}

// 2. Explicit Microphone Permission Trigger
async function requestMobileMicrophone() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Instantly release tracks so Web Speech API can control the mic hardware line
        stream.getTracks().forEach(track => track.stop());
        return true;
    } catch (err) {
        console.error("Microphone Access Error:", err);
        alert("Microphone access is required. Please check your browser or iOS Safari permission settings.");
        return false;
    }
}

// 3. UI State Updater
function updateUI(statusText, visualState = '') {
    const statusLabel = document.getElementById('status-label') || document.querySelector('.status-text');
    const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');

    if (statusLabel) statusLabel.textContent = statusText;
    if (orb && visualState) {
        orb.setAttribute('data-state', visualState);
    }
}

// 4. Web Speech Synthesis Fallback
function speakFallback(text, onComplete) {
    if (!('speechSynthesis' in window)) {
        if (onComplete) onComplete();
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => { if (onComplete) onComplete(); };
    utterance.onerror = (err) => {
        console.error("SpeechSynthesis error:", err);
        if (onComplete) onComplete();
    };
    window.speechSynthesis.speak(utterance);
}

// 5. End-to-End Voice & LLM Pipeline Handler
async function sendVoiceQuery(queryText) {
    if (isProcessing) return;
    isProcessing = true;

    unlockIOSAudio();
    updateUI("THINKING...", "thinking");

    if (recognition) {
        try { recognition.stop(); } catch (e) {}
    }

    const resumeListener = () => {
        isProcessing = false;
        updateUI("LISTENING", "listening");
        if (recognition) {
            try { recognition.start(); } catch (e) {}
        }
    };

    try {
        console.log("Sending query to backend:", queryText);

        const chatResponse = await fetch(`${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'bypass-tunnel-reminder': 'true'
            },
            body: JSON.stringify({ prompt: queryText })
        });

        if (!chatResponse.ok) {
            throw new Error(`Chat HTTP Error: ${chatResponse.status}`);
        }

        const chatData = await chatResponse.json();
        const replyText = chatData.response || chatData.reply || "No response received.";

        updateUI("TATI SPEAKING", "speaking");

        try {
            const ttsResponse = await fetch(`${BACKEND_URL}/api/tts`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'bypass-tunnel-reminder': 'true'
                },
                body: JSON.stringify({ text: replyText })
            });

            if (!ttsResponse.ok) {
                throw new Error(`TTS HTTP Error: ${ttsResponse.status}`);
            }

            const audioBlob = await ttsResponse.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);

            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                resumeListener();
            };

            audio.onerror = (err) => {
                console.warn("Kokoro audio playback failed, triggering browser fallback:", err);
                speakFallback(replyText, resumeListener);
            };

            await audio.play();

        } catch (ttsErr) {
            console.warn("TTS backend fetch failed, falling back to Web Speech:", ttsErr);
            speakFallback(replyText, resumeListener);
        }

    } catch (err) {
        console.error("Pipeline query error:", err);
        updateUI("ERROR OCCURRED", "error");
        speakFallback("Sorry, I could not reach the host backend.", resumeListener);
    }
}

// 6. Speech Recognition Listener Initialization
function initSpeechRecognition() {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
        console.warn("Web Speech Recognition API is not supported in this browser context.");
        updateUI("SPEECH API UNSUPPORTED", "error");
        return;
    }

    recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        console.log('Voice-to-Wake active. Listening for "Hey Tati"...');
        if (!isProcessing) updateUI("LISTENING", "listening");
    };

    recognition.onresult = (event) => {
        if (isProcessing) return;

        const lastIndex = event.results.length - 1;
        const transcript = event.results[lastIndex][0].transcript.trim().toLowerCase();
        console.log("Speech input captured:", transcript);

        if (transcript.includes("hey tati") || transcript.includes("tati")) {
            console.log("⚡ Wake word detected:", transcript);
            const queryText = transcript.replace(/.*(?:hey tati|tati)/i, '').trim();

            if (queryText.length > 0) {
                sendVoiceQuery(queryText);
            } else {
                updateUI("SAY YOUR QUERY...", "listening");
            }
        } else if (transcript.length > 2) {
            sendVoiceQuery(transcript);
        }
    };

    recognition.onerror = (event) => {
        console.warn("Speech listener event error:", event.error);
        if (event.error === 'not-allowed') {
            updateUI("MIC PERMISSION DENIED", "error");
        }
    };

    recognition.onend = () => {
        if (!isProcessing) {
            try { recognition.start(); } catch (e) {}
        }
    };
}

// 7. Global Window Method - Called by "START VOICE CONSOLE" button in index.html
window.initiateWelcomeConsole = async function() {
    // Hide the welcome overlay modal
    const welcomeOverlay = document.getElementById('welcome-overlay') || 
                           document.getElementById('welcome-screen') || 
                           document.getElementById('welcome-modal') ||
                           document.querySelector('.welcome-modal') ||
                           document.querySelector('.fixed.inset-0') ||
                           document.querySelector('[class*="z-50"]');
                           
    if (welcomeOverlay) {
        welcomeOverlay.style.display = 'none';
    }

    // Unlock Web Audio for iOS Safari & Desktop
    unlockIOSAudio();

    // Trigger explicit mic permission prompt
    const micGranted = await requestMobileMicrophone();

    if (micGranted) {
        if (!recognition) {
            initSpeechRecognition();
        }
        try {
            if (recognition) recognition.start();
        } catch (e) {
            console.log("Recognition active:", e);
        }
    }
};

// 8. Event Listener Attachment
document.addEventListener('DOMContentLoaded', () => {
    const orbButton = document.getElementById('orb-button') || document.querySelector('.orb-container');
    const startButton = document.querySelector('button[onclick*="initiateWelcomeConsole"]') || 
                        document.querySelector('button:has(span)');

    document.addEventListener('touchstart', unlockIOSAudio, { passive: true });
    document.addEventListener('click', unlockIOSAudio, { passive: true });

    if (startButton) {
        startButton.addEventListener('click', window.initiateWelcomeConsole);
    }

    if (orbButton) {
        orbButton.addEventListener('click', async () => {
            unlockIOSAudio();
            const micGranted = await requestMobileMicrophone();
            if (micGranted) {
                if (!recognition) initSpeechRecognition();
                try { recognition.start(); } catch (e) {}
            }
        });
    }
});