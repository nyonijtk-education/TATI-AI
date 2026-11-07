from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import meilisearch

app = FastAPI(title="Tati Search Engine API")

# Configure CORS for your hosted domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Replace with production domain (e.g. https://your-site.vercel.app)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connect to persistent Meilisearch host
meili_client = meilisearch.Client('https://your-meilisearch-instance.com', 'YOUR_SECURE_MASTER_KEY')
index = meili_client.index('academic_library')

# Configure Index Settings for Maximum Throughput
index.update_settings({
    'searchableAttributes': ['title', 'abstract', 'content', 'keywords', 'domain'],
    'filterableAttributes': ['domain', 'year', 'category'],
    'sortableAttributes': ['year']
})

@app.post("/search")
async def search_academic_data(query: str):
    results = index.search(query, {
        'limit': 20,
        'attributesToHighlight': ['content']
    })
    return results