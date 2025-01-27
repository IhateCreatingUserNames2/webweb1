const express = require("express");
const bodyParser = require("body-parser");
const { Pinecone } = require("@pinecone-database/pinecone");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Get MiniMax, Pinecone, and OpenAI API keys from environment variables
const MINI_MAX_API_KEY = process.env.MiniMax_API_KEY; 
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // For OpenAI Embedding API
const PINECONE_HOST = "https://bluew-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Your Pinecone host
const INDEX_NAME = "bluew";

if (!PINECONE_API_KEY || !OPENAI_API_KEY || !MINI_MAX_API_KEY) {
  console.error(
    "Error: PINECONE_API_KEY, OPENAI_API_KEY, or MINI_MAX_API_KEY is not set. Please configure them in the environment variables."
  );
  process.exit(1);
}

// Initialize Pinecone client
const pinecone = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

// Middleware to log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(bodyParser.json());
app.use(express.static(__dirname)); // Serve static files like index.html

// Serve index.html at the root route
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Function to fetch context from Pinecone
async function fetchContext(message) {
  const index = pinecone.index(INDEX_NAME, PINECONE_HOST);

  // Call OpenAI Embedding API
  const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: message,
      model: "text-embedding-3-large",
    }),
  });

  const embeddingData = await embeddingResponse.json();

  // Log embedding response for debugging
  console.log("Embedding Response:", embeddingData);

  // Validate the response
  if (!embeddingData || !embeddingData.data || embeddingData.data.length === 0) {
    throw new Error("Invalid embedding response from OpenAI.");
  }

  const queryVector = embeddingData.data[0].embedding;

  // Query Pinecone for context
  const pineconeResponse = await index.query({
    topK: 20,
    vector: queryVector,
    includeMetadata: true,
  });

  // Log Pinecone response for debugging
  console.log("Pinecone Response:", pineconeResponse);

  if (!pineconeResponse || !pineconeResponse.matches || pineconeResponse.matches.length === 0) {
    return ""; // No matches found
  }

  return pineconeResponse.matches
    .map((match) => match.metadata.text)
    .join("\n");
}

// Function to generate a response using the selected LLM
async function generateResponse(message, context, provider) {
  if (provider === "openai") {
    const prompt = `
CONTEXT:
${context}

USER QUESTION:
${message}

BOT RESPONSE:
`;
    const apiResponse = await fetch("https://api.openai.com/v1/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        prompt,
        max_tokens: 1500,
        temperature: 0.7,
      }),
    });
    const data = await apiResponse.json();

    // Log the OpenAI response for debugging
    console.log("OpenAI GPT-4 Response:", data);

    return data.choices[0]?.text?.trim() || "No response generated.";
  } else if (provider === "minimax") {
    const apiResponse = await fetch("https://api.minimaxi.chat/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINI_MAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: "MiniMax-Text-01",
        max_tokens: 1024,
        temperature: 0.8,
        top_p: 0.9,
        messages: [
          {
            role: "system",
            content: `CONTEXT:\n${context}`,
          },
          {
            role: "user",
            content: message,
          },
        ],
      }),
    });
    const data = await apiResponse.json();

    // Log the MiniMax response for debugging
    console.log("MiniMax Response:", data);

    return data.choices[0]?.message.content || "No response generated.";
  } else {
    throw new Error("Invalid provider selected.");
  }
}

// Chatbot endpoint with support for both MiniMax and OpenAI
app.post("/chatbot", async (req, res) => {
  const { message, provider } = req.body;

  if (!message || !provider) {
    return res.status(400).json({ error: "Message and provider are required." });
  }

  try {
    // Fetch context from Pinecone
    const context = await fetchContext(message);

    // Generate response using the selected provider
    const reply = await generateResponse(message, context, provider);

    res.json({ reply });
  } catch (error) {
    console.error("Error in /chatbot:", error.message);
    res.status(500).json({ error: "An error occurred while processing your request." });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
