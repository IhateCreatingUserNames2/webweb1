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

// Allowed OpenAI models
const ALLOWED_MODELS = ["gpt-4o", "chatgpt-4o-latest", "o1"];

if (!PINECONE_API_KEY || !OPENAI_API_KEY || !MINI_MAX_API_KEY) {
  console.error("Error: API keys not set. Please configure them in the environment variables.");
  process.exit(1);
}

// Initialize Pinecone client
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

app.use(bodyParser.json());
app.use(express.static(__dirname)); // Serve static files like index.html

// Serve index.html at the root route
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Initialize an array to store chat history
const chatHistory = [];

// Function to fetch relevant context from Pinecone
async function fetchContext(message) {
  try {
    const index = pinecone.index(INDEX_NAME, PINECONE_HOST);

    // Get embedding from OpenAI
    const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ input: message, model: "text-embedding-3-large" }),
    });

    const embeddingData = await embeddingResponse.json();

    if (!embeddingData.data || embeddingData.data.length === 0) {
      throw new Error("Invalid embedding response from OpenAI.");
    }

    const queryVector = embeddingData.data[0].embedding;

    // Query Pinecone for relevant context
    const pineconeResponse = await index.query({
      topK: 5, // Reduced from 10 to avoid too much noise
      vector: queryVector,
      includeMetadata: true,
    });

    console.log("🔍 Pinecone Raw Response:", pineconeResponse);

    // Filter results with high relevance score
    const relevantMatches = pineconeResponse.matches
      .filter(match => match.score > 0.3) // Only results with similarity > 0.7
      .map(match => match.metadata.text);

    console.log("📌 Contexto relevante encontrado:", relevantMatches);

    return relevantMatches.length ? relevantMatches.join("\n") : "Nenhuma informação relevante encontrada.";
  } catch (error) {
    console.error("❌ Error in fetchContext:", error.message);
    return "Erro ao recuperar contexto.";
  }
}

// Function to generate response using LLMs
async function generateResponse(message, context, provider, model) {
  chatHistory.push({ role: "user", content: message });

  if (chatHistory.length > 6) {
    chatHistory.splice(0, 2); // Keep only the last 3 user interactions
  }

  const MAX_CONTEXT_LENGTH = 2000;
  const trimmedContext = context.length > MAX_CONTEXT_LENGTH ? context.substring(0, MAX_CONTEXT_LENGTH) : context;

  const systemMessage = `
Você é Roberta, uma assistente Virtual da BlueWidow Energia LTDA.
Você fornece informações sobre produtos, incluindo inversores e geradores híbridos.

### 📌 Informações Recuperadas:
${trimmedContext}  

Se a resposta estiver no contexto acima, use **somente esses dados**. Se não houver informação relevante, diga: "Não encontrei informações sobre este item." e pergunte se tem algo mais que possa ajudar. 

### 🔍 Histórico de Conversa:
${chatHistory.slice(-6).map(msg => msg.role === "user" ? `👤 Usuário: ${msg.content}` : `🤖 Mai: ${msg.content}`).join("\n")}

📢 **Responda de forma clara e formatada em Markdown.**
`.trim();

  if (provider === "openai") {
    // Validate model
    if (!ALLOWED_MODELS.includes(model)) {
      console.warn(`⚠️ Invalid model "${model}" selected. Defaulting to gpt-4o.`);
      model = "gpt-4o"; // Default model if invalid
    }

    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: model, // Use the selected model
        messages: [
          { role: "system", content: systemMessage },
          ...chatHistory.slice(-6),
          { role: "user", content: message }
        ],
        max_tokens: 1500,
        temperature: 0.7
      }),
    });

    const openaiData = await chatResponse.json();
    console.log("💬 OpenAI Response:", openaiData);

    if (openaiData.choices?.[0]?.message?.content) {
      chatHistory.push({ role: "assistant", content: openaiData.choices[0].message.content.trim() });
      return openaiData.choices[0].message.content.trim();
    }

    return "No response generated.";
  } else {
    throw new Error("Invalid provider selected.");
  }
}

// Chatbot endpoint with support for both MiniMax and OpenAI
app.post("/chatbot", async (req, res) => {
  const { message, provider, model } = req.body;

  if (!message || !provider) {
    return res.status(400).json({ error: "Message, provider, and model are required." });
  }

  try {
    // Fetch relevant context from Pinecone
    const context = await fetchContext(message);

    // Generate response using selected provider and model
    const reply = await generateResponse(message, context, provider, model);

    res.json({ reply });
  } catch (error) {
    console.error("❌ Error in /chatbot:", error.message);
    res.status(500).json({ error: "An error occurred while processing your request." });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
