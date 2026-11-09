// Complete production-ready chat.js for Tati Voice AI Platform
const BACKEND_URL = 'https://tati-voice-ai-backend.loca.lt';

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let recognition = null;
let isProcessing = false;

// 1. Hide Welcome Overlay Immediately
function hideWelcomeModal() {
    const modalSelectors = [
        '#welcome-overlay', '#welcome-modal', '#welcome-screen',
        '.welcome-modal', '[id*="welcome"]', '.fixed.inset-0', '[class*="z-50"]'
    ];
    modalSelectors.forEach(selector => {
        const el = document.querySelector(selector);
        if (el) {
            el.style.display = 'none';
            el.style.visibility = 'hidden';
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            el.classList.add('hidden');
        }
    });
}

// 2. Web Audio Unlocker for iOS Safari & Desktop Browsers
function unlockIOSAudio() {
    try {
        if (!audioCtx) {
            audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const buffer = audioCtx.createBuffer(1, 1, 22050);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } catch (e) {
        console.log("Audio unlock:", e);
    }
}

// 3. User-Gesture Microphone Permission Trigger
async function requestMobileMicrophone() {
    try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
        }
        return true;
    } catch (err) {
        console.error("Microphone Access Error:", err);
        return false;
    }
}

// 4. UI State Updater
function updateUI(statusText, visualState = '') {
    const statusLabel = document.getElementById('status-label') || document.querySelector('.status-text') || document.querySelector('[id*="status"]');
    const orb = document.getElementById('orb-button') || document.querySelector('.orb-container') || document.querySelector('[id*="orb"]');

    if (statusLabel) statusLabel.textContent = statusText;
    if (orb && visualState) {
        orb.setAttribute('data-state', visualState);
    }
}

// 5. Browser Web Speech Synthesis Fallback
function speakFallback(text, onComplete) {
    if (!('speechSynthesis' in window)) {
        if (onComplete) onComplete();
        return;
    }
    try {
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
    } catch (e) {
        if (onComplete) onComplete();
    }
}

// 6. Global speakResponse Function (Required by index.html line 582)
async function speakResponse(text, onComplete) {
    updateUI("TATI SPEAKING", "speaking");
    try {
        const ttsResponse = await fetch(`${BACKEND_URL}/api/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'bypass-tunnel-reminder': 'true'
            },
            body: JSON.stringify({ text: text })
        });

        if (!ttsResponse.ok) throw new Error(`TTS Status ${ttsResponse.status}`);

        const audioBlob = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            if (onComplete) onComplete();
        };

        audio.onerror = () => {
            speakFallback(text, onComplete);
        };

        await audio.play();

    } catch (err) {
        console.warn("Backend TTS fetch failed, using Web Speech fallback:", err);
        speakFallback(text, onComplete);
    }
}

// 7. End-to-End Voice Query Pipeline
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
        console.log("Sending query:", queryText);

        const chatResponse = await fetch(`${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'bypass-tunnel-reminder': 'true'
            },
            body: JSON.stringify({ prompt: queryText })
        });

        if (!chatResponse.ok) throw new Error(`Chat HTTP Error: ${chatResponse.status}`);

        const chatData = await chatResponse.json();
        const replyText = chatData.response || chatData.reply || "No response received.";

        await speakResponse(replyText, resumeListener);

    } catch (err) {
        console.error("Pipeline query error:", err);
        updateUI("ERROR OCCURRED", "error");
        speakFallback("Sorry, I could not reach the backend server.", resumeListener);
    }
}

// 8. Speech Recognition Listener
function initSpeechRecognition() {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
        console.warn("Speech recognition unsupported in this browser.");
        updateUI("SPEECH API UNSUPPORTED", "error");
        return;
    }

    try {
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
            console.warn("Speech listener error:", event.error);
        };

        recognition.onend = () => {
            if (!isProcessing) {
                try { recognition.start(); } catch (e) {}
            }
        };
    } catch (e) {
        console.error("Error initializing recognition:", e);
    }
}

// 9. Welcome Console Handler called by button in index.html
async function initiateWelcomeConsole() {
    hideWelcomeModal();
    unlockIOSAudio();
    
    await requestMobileMicrophone();

    if (!recognition) {
        initSpeechRecognition();
    }
    try {
        if (recognition) recognition.start();
    } catch (e) {}

    speakResponse("Welcome to Tati Voice AI Console. Local Kokoro neural speech engine online. Say Hey Tati or tap the orb to begin.");
}

// 10. Bind to Window Scope for Inline HTML Handlers
window.speakResponse = speakResponse;
window.sendVoiceQuery = sendVoiceQuery;
window.initiateWelcomeConsole = initiateWelcomeConsole;
window.hideWelcomeModal = hideWelcomeModal;

// 11. Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('touchstart', unlockIOSAudio, { passive: true });
    document.addEventListener('click', unlockIOSAudio, { passive: true });

    const startBtn = document.querySelector('button[onclick*="initiateWelcomeConsole"]') || document.querySelector('button');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            initiateWelcomeConsole();
        });
    }

    const orb = document.getElementById('orb-button') || document.querySelector('.orb-container');
    if (orb) {
        orb.addEventListener('click', async () => {
            hideWelcomeModal();
            unlockIOSAudio();
            await requestMobileMicrophone();
            if (!recognition) initSpeechRecognition();
            try { recognition.start(); } catch (e) {}
        });
    }
});