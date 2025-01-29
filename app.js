const express = require("express");
const bodyParser = require("body-parser");
const { Pinecone } = require("@pinecone-database/pinecone");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Get MiniMax, Pinecone, and OpenAI API keys from environment variables
const MINI_MAX_API_KEY = process.env.MiniMax_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // For OpenAI Embedding and Chat APIs
const PINECONE_HOST = "https://bluew-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Pinecone host
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

// Initialize an array to store chat history
const chatHistory = [];

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
      model: "text-embedding-3-large", // or "text-embedding-ada-002" if preferred
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
    topK: 35,
    vector: queryVector,
    includeMetadata: true,
  });

  // Log Pinecone response for debugging
  console.log("Pinecone Response:", pineconeResponse);

  if (
    !pineconeResponse ||
    !pineconeResponse.matches ||
    pineconeResponse.matches.length === 0
  ) {
    return ""; // No matches found; return empty context
  }

  return pineconeResponse.matches
    .map((match) => match.metadata.text)
    .join("\n");
}

// Function to generate a response using the selected LLM
async function generateResponse(message, context, provider) {
  // Add the current user message to the chat history
  chatHistory.push({ role: "user", content: message });

  // Keep only the last 5 interactions (10 messages, since each interaction has a user and AI message)
  if (chatHistory.length > 10) {
    chatHistory.splice(0, 2); // Remove the oldest two messages (one user and one AI)
  }

  // Construct the system message with hard-coded knowledge and chat history
  const systemMessage = `
Você é Mai, uma assistente Virtual da BlueWidow Energia LTDA
Knowlegde About BlueWidow Energia LTDA: "Você Gera propostas para Geradores Hibridos fabricados pela BlueWidow Energia LTDA. Você gera propostas para implantação de Usinas Solares. Você tem vasta memoria sobre a blueWidow utilizando RAG. A BlueWidow Energia LTDA está localizada na cidade de Anápolis, no Estado de Goias, no Pais Brasil. Wilson é Diretor da BlueWidow.A BlueWidow Energia LTDA oferece serviços de : Energia Solar, Geração de Energia, Automação e Infraestrutura Industrial. Subestações e Linhas de Transmissão de Energia, Manutenção de Energia, Geradores de Energia Solar Hibridos.  "

Below are some context based on User Input:${context}

The UserInput: 

Last 5 ChatHistory Between you and User:
${chatHistory.slice(-10).map((msg, index) => {
    if (msg.role === "user") {
      return `User: ${msg.content}`;
    } else if (msg.role === "assistant") {
      return `AI: ${msg.content}`;
    }
  }).join("\n")}
Usando todas as informações responda corretamente ao UserInput.
**Responda utilizando Markdown formatado corretamente.**
  `.trim();

  if (provider === "openai") {
    // Using the Chat Completions endpoint with GPT-4
    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          { role: "system", content: systemMessage },
          ...chatHistory.slice(-10),
          { role: "user", content: message }
        ],
        max_tokens: 1500,
        temperature: 0.7
      }),
    });

    const openaiData = await chatResponse.json();
    console.log("OpenAI GPT-4 Response:", openaiData);

    // Add the AI's response to the chat history
    if (openaiData.choices && openaiData.choices[0] && openaiData.choices[0].message) {
      chatHistory.push({ role: "assistant", content: openaiData.choices[0].message.content.trim() });
    }

    return openaiData.choices?.[0]?.message?.content?.trim() || "No response generated.";
  } else if (provider === "minimax") {
    // Using the MiniMax API
    const miniMaxResponse = await fetch("https://api.minimaxi.chat/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINI_MAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: "MiniMax-Text-01",
        max_tokens: 102400,
        temperature: 0.8,
        top_p: 0.9,
        messages: [
          { role: "system", content: systemMessage },
          ...chatHistory.slice(-10),
          { role: "user", content: message }
        ],
      }),
    });

    const miniMaxData = await miniMaxResponse.json();
    console.log("MiniMax Response:", miniMaxData);

    // Add the AI's response to the chat history
    if (miniMaxData.choices && miniMaxData.choices[0] && miniMaxData.choices[0].message) {
      chatHistory.push({ role: "assistant", content: miniMaxData.choices[0].message.content });
    }

    return miniMaxData.choices?.[0]?.message?.content || "No response generated.";
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
