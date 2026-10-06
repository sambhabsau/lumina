# DESIGN.md — LUMINA

## Components

Web UI - user's browser; Vercel web app
Gateway - publicly reachable Node process located in Fly.io, no API keys
Agent service - private Node process reachable only from Gateway, has no URL
  - defines what tools are available and enforces max number of turns
  - stateless between requests, every turn is reloaded from MongoDB
MongoDB Atlas - managed cloud service
  - stateful and holds the full conversation history 
Search Cache - 2-tier -> tier 1 is in the agent's memory & tier 2 is in MongoDB Atlas
Run logs - agent writes one JSON file to Fly's local disk and a persistent copy in MongoDB
Job Collection - deep search functionality and each row would be stateful 

## Responsibilities

The web UI or browser only communicates with the Gateway as it is the only component with a public address. Only the agent contains the provider keys like that of Anthropic and MongoDB. Further, the agent will decide if a request is over its cap or maximum number of turns. MongoDB is the only persistent store where messages are stored in a collection called threads. The agent is stateless between requests and must reload threads state from MongoDB with every turn. One run log is written by the agent per request. The Job Collection is designed to be a MongoDB collection polled by a worker (not built).

## Communication

The Browser and Gateway communicate with each other via HTTP requests and responses for most cases. There is also SSE for gateway being able to return the state of the search happening live to the browser. The Gateway and Agent will communicate with each other via HTTP, but never over the public Internet so that the provider keys stored in the Agent are never exposed. Interestingly, communication between the Agent and MongoDB is done over the Mongo wire protocol directly so that the agent can do random-access reads/writes to thread history and the cache on every turn. When the agent is down, a thrown fetch becomes a 502 from the gateway. What hasn't been built is the job collection to and from worker which would be a Mongo collection polled by a worker, not SSE or HTTP, so that a browser is not waiting synchronously on a deep-search job. 

## State

The messages are embedded into an array that is collected into threads which is stored in MongoDB authoritatively. You could delete the search cache and would only increase latency for repeated requests. Further, the agent is the only writer, and the only process that opens a Mongo connection at all. 

## Trade-offs
RED-LINES explained.
A2: The 4 runs are labelled truthfully as cap and error, never as done, and it was left in on purpose.
R2: the test only runs if deep search exists. I didn't build deep search, and quick search has no plan_research tool anyway.

Firstly, due to time constraints, I only implemented the Quick Search + Citations + Observability with honest 501s elsewhere, such as for Deep Search + RAG. 

Secondly, my agent used Sonnet instead of Opus exclusively for every model call. I chose the cheaper model Sonnet and accepted some quality issues with harder questions. However, as most questions will be either easy/medium, this should be a minor issue. 

Thirdly, I designed the chunk schema around Atlas Vector Search which is just an embedding stored as another field in the document. On the other hand, a reasonable engineer may have one database for text/citations (MongoDB) and a separate one for vector (e.g. Pinecone). However, this creates overhead where every citation lookup needs both systems to agree. Further, if you write to one and forget the other, they will drift out of sync. Therefore, only Atlas Vector Search was used to avoid any syncing problem where each document only has one query for synthesizing. To note, this feature is not yet used in my project as RAG is not implemented yet. Therefore, I'm not sure if committing to this storage decision, before building the features that used it, was a good idea. Atlas's M0 cap caps me at 3 search indexes and creating chunks_text failed with error stating that maximum number of indexes had been reached with the given instance size. 

Lastly, harness-enforced "grounding" was used to ensure the agent actually fetched or read a citation it uses in its final answer. The code now hard-enforces that the agent actually "read" a source before using it as a citation, instead of just trusting that the agent will do it autonomously. Originally, citations were added to answers without actually reading the source in about 50% of cases. This hard-coded fix causes each answer generation to become slower and pricier. Stricter grounding also means that the agent fetches more pages, which causes some runs to run out of turns. 
