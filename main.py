import os
import meilisearch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI

# 1. Initialize FastAPI Application
app = FastAPI(title="Tati Search Engine API")

# Configure CORS for your hosted domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Replace with production domain (e.g., https://your-site.vercel.app)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. Connect to Persistent Local Meilisearch Host with Master Key
MEILI_URL = os.getenv("MEILISEARCH_URL", "http://127.0.0.1:7700")
MEILI_KEY = os.getenv("MEILISEARCH_MASTER_KEY", "Tati_Secure_MasterKey_8f9A2b4C6e1D3f5A7b9C")

meili_client = meilisearch.Client(MEILI_URL, MEILI_KEY)
index = meili_client.index("academic_library")

# Safe initialization of index settings
try:
    index.update_settings({
        'searchableAttributes': ['title', 'abstract', 'content', 'keywords', 'domain'],
        'filterableAttributes': ['domain', 'year', 'category'],
        'sortableAttributes': ['year']
    })
except Exception as e:
    print(f"Warning: Could not connect to Meilisearch at startup. Make sure Meilisearch is running with your master key: {e}")

# 3. Connect to Local Ollama Desktop Application
llm_client = OpenAI(
    base_url="http://localhost:11434/v1",
    api_key="ollama-local"  # Required by SDK, ignored by local Ollama
)

# 4. Request Schemas
class SearchQuery(BaseModel):
    query: str
    limit: int = 20

class VoiceRAGRequest(BaseModel):
    transcript: str

# 5. API Endpoints

@app.get("/")
async def root():
    return {"status": "online", "message": "Tati Voice AI & Search Backend is running."}

@app.post("/search")
async def search_academic_data(payload: SearchQuery):
    try:
        results = index.search(payload.query, {
            'limit': payload.limit,
            'attributesToHighlight': ['content']
        })
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Meilisearch query failed: {str(e)}")

@app.post("/api/chat")
async def rag_voice_chat(payload: VoiceRAGRequest):
    if not payload.transcript.strip():
        raise HTTPException(status_code=400, detail="Voice transcript cannot be empty.")

    try:
        # Step A1: Try Full Transcript Search
        search_results = index.search(payload.transcript, {
            'limit': 3,
            'attributesToRetrieve': ['title', 'abstract', 'content']
        })

        if isinstance(search_results, dict):
            hits = search_results.get('hits', [])
        else:
            hits = getattr(search_results, 'hits', [])

        # Step A2: Robust Keyword Fallback Search if 0 Hits
        if not hits:
            # Only filter out conversational framing words (keep domain words like 'data', 'oceanography', etc.)
            stop_words = {"what", "are", "the", "latest", "findings", "tell", "me", "about", "research", "in", "is", "a", "of", "and", "or", "for", "to", "on"}
            cleaned_transcript = payload.transcript.lower().replace("?", "").replace(".", "").replace(",", "")
            keywords = [word for word in cleaned_transcript.split() if word not in stop_words]
            
            fallback_query = " ".join(keywords) if keywords else payload.transcript

            # Search with 'matchingStrategy': 'last' to allow matching ANY remaining domain keywords
            search_results = index.search(fallback_query, {
                'limit': 3,
                'matchingStrategy': 'last',
                'attributesToRetrieve': ['title', 'abstract', 'content']
            })
            
            if isinstance(search_results, dict):
                hits = search_results.get('hits', [])
            else:
                hits = getattr(search_results, 'hits', [])

        if not hits:
            return {
                "response_text": "I could not find any matching records in the academic library.",
                "database_hits": 0
            }

        # Step B: Format Knowledge Context
        formatted_context = ""
        for i, hit in enumerate(hits, 1):
            if isinstance(hit, dict):
                title = hit.get('title', 'Untitled')
                content = hit.get('content') or hit.get('abstract', '')
            else:
                title = getattr(hit, 'title', 'Untitled')
                content = getattr(hit, 'content', None) or getattr(hit, 'abstract', '')
            formatted_context += f"Record {i} - {title}:\n{content}\n\n"

        # Step C: Generate Response via Local Ollama
        system_prompt = (
            "You are Tati, an Earth science research Voice AI. Answer the query using "
            "ONLY the exact database records provided. Keep responses clear and limited to 2 concise sentences for voice delivery."
        )

        user_prompt = f"Database Records:\n{formatted_context}\nUser Request: \"{payload.transcript}\""

        completion = llm_client.chat.completions.create(
            model="llama3",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.1,
            max_tokens=150
        )

        return {
            "response_text": completion.choices[0].message.content,
            "database_hits": len(hits)
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAG Pipeline error: {str(e)}")

# 6. Direct Server Launcher
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)