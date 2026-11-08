import os
import json
import meilisearch

# 1. Configuration
MEILI_URL = os.getenv("MEILISEARCH_URL", "http://127.0.0.1:7700")
MEILI_KEY = os.getenv("MEILISEARCH_MASTER_KEY", "Tati_Secure_MasterKey_8f9A2b4C6e1D3f5A7b9C")
INDEX_NAME = "academic_library"
BATCH_SIZE = 1000

# 2. Connect to Meilisearch
client = meilisearch.Client(MEILI_URL, MEILI_KEY)
index = client.index(INDEX_NAME)

def configure_index():
    print("Configuring index settings...")
    index.update_settings({
        'searchableAttributes': ['title', 'abstract', 'content', 'keywords', 'domain'],
        'filterableAttributes': ['domain', 'year', 'category'],
        'sortableAttributes': ['year']
    })

def generate_mock_dataset(filename="synthetic_academic_dataset.json", count=5000):
    print(f"Generating synthetic dataset with {count} records...")
    domains = ["climatology", "oceanography", "meteorology", "geology", "atmospheric_science"]
    dataset = []
    
    for i in range(1, count + 1):
        domain = domains[i % len(domains)]
        doc = {
            "id": i,
            "title": f"Research Study {i}: Advances in {domain.capitalize()} Data",
            "abstract": f"Comprehensive analysis of empirical observations regarding {domain} patterns in 2026.",
            "content": f"Global environmental models show major atmospheric shifts in {domain} based on satellite telemetry.",
            "domain": domain,
            "year": 2020 + (i % 7)
        }
        dataset.append(doc)

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(dataset, f, indent=2)
    
    print(f"Saved synthetic dataset to '{filename}'")
    return filename

def find_dataset_file():
    search_dirs = [".", "dumps", "api"]
    valid_extensions = (".json", ".jsonl", ".csv")
    ignore_files = {"package.json", "package-lock.json", "vercel.json", "tsconfig.json"}

    for directory in search_dirs:
        if os.path.exists(directory):
            for file in os.listdir(directory):
                if file in ignore_files or file.startswith("."):
                    continue
                if file.endswith(valid_extensions):
                    full_path = os.path.join(directory, file)
                    if os.path.isfile(full_path):
                        return full_path
    return None

def stream_and_upload(file_path):
    print(f"Reading dataset from '{file_path}'...")
    
    with open(file_path, "r", encoding="utf-8") as f:
        if file_path.endswith(".json"):
            data = json.load(f)
            if isinstance(data, dict):
                data = [data]  # Wrap single dict in a list
        elif file_path.endswith(".jsonl"):
            data = [json.loads(line) for line in f if line.strip()]
        else:
            raise ValueError("Unsupported format. Please provide .json or .jsonl")

    total_docs = len(data)
    print(f"Total documents to index: {total_docs}")

    for i in range(0, total_docs, BATCH_SIZE):
        batch = data[i:i + BATCH_SIZE]
        task = index.add_documents(batch)
        batch_num = (i // BATCH_SIZE) + 1
        print(f"Enqueued Batch {batch_num} ({len(batch)} docs) - Task UID: {task.task_uid}")

if __name__ == "__main__":
    try:
        configure_index()
        
        target_file = find_dataset_file()
        if not target_file:
            print("No external dataset dump found. Generating mock dataset...")
            target_file = generate_mock_dataset()

        stream_and_upload(target_file)
        print("\nDataset successfully enqueued for background indexing!")
        
    except Exception as e:
        print(f"\nError during dataset import: {str(e)}")