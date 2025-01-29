const express = require("express");
const bodyParser = require("body-parser");
const { Pinecone } = require("@pinecone-database/pinecone");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// Get API keys from environment variables
const MINI_MAX_API_KEY = process.env.MiniMax_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const PINECONE_HOST = "https://bluew-xek6roj.svc.aped-4627-b74a.pinecone.io"; 
const INDEX_NAME = "bluew";

// Allowed OpenAI models
const ALLOWED_MODELS = ["gpt-4o", "chatgpt-4o-latest", "o1"];

if (!PINECONE_API_KEY || !OPENAI_API_KEY || !MINI_MAX_API_KEY) {
  console.error("❌ Missing API keys. Set them in the environment variables.");
  process.exit(1);
}

// Initialize Pinecone client
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

app.use(bodyParser.json());
app.use(express.static(__dirname)); 

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Chat history storage
const chatHistory = [];

// 🛠️ **Fetch relevant context from Pinecone**
async function fetchContext(message) {
  try {
    const index = pinecone.index(INDEX_NAME, PINECONE_HOST);

    // 🧠 Get query embedding from OpenAI
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
      throw new Error("🚨 No embedding data received from OpenAI.");
    }

    const queryVector = embeddingData.data[0].embedding;

    // 🔍 Query Pinecone for similar items
    const pineconeResponse = await index.query({
      vector: queryVector,
      topK: 5,
      includeMetadata: true,
      filter: { type: { "$eq": "MONO L1" } } // 🎯 Querying only MONO L1 inverters
    });

    console.log("🔍 Pinecone Raw Response:", pineconeResponse);

    // 🏆 Filter relevant results based on score
    const relevantMatches = pineconeResponse.matches
      .filter(match => match.score > 0.7) // 🔥 Keep only high similarity scores
      .map(match => match.metadata.text);

    console.log("📌 Relevant Context:", relevantMatches);

    return relevantMatches.length ? relevantMatches.join("\n") : "Nenhuma informação relevante encontrada.";
  } catch (error) {
    console.error("❌ Error in fetchContext:", error.message);
    return "Erro ao recuperar contexto.";
  }
}

// 🤖 **Generate response using OpenAI**
async function generateResponse(message, context, provider, model) {
  chatHistory.push({ role: "user", content: message });

  if (chatHistory.length > 6) {
    chatHistory.splice(0, 2); // Keep only last 3 user messages
  }

  const MAX_CONTEXT_LENGTH = 2000;
  const trimmedContext = context.length > MAX_CONTEXT_LENGTH ? context.substring(0, MAX_CONTEXT_LENGTH) : context;

  const systemMessage = `
Você é Roberta, assistente Virtual da BlueWidow Energia LTDA.
Forneça informações sobre inversores e geradores híbridos.

### 📌 Informações Recuperadas:
${trimmedContext}  

Se a resposta estiver no contexto acima, use **somente esses dados**. Caso contrário, diga: "Não encontrei informações sobre este item."

### 🔍 Histórico de Conversa:
${chatHistory.slice(-6).map(msg => msg.role === "user" ? `👤 Usuário: ${msg.content}` : `🤖 Roberta: ${msg.content}`).join("\n")}

📢 **Responda de forma clara e formatada em Markdown.**
`.trim();

  if (provider === "openai") {
    if (!ALLOWED_MODELS.includes(model)) {
      console.warn(`⚠️ Invalid model "${model}" selected. Defaulting to gpt-4o.`);
      model = "gpt-4o"; 
    }

    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
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

// 📨 **Chatbot API Endpoint**
app.post("/chatbot", async (req, res) => {
  const { message, provider, model } = req.body;

  if (!message || !provider) {
    return res.status(400).json({ error: "Message, provider, and model are required." });
  }

  try {
    const context = await fetchContext(message);
    const reply = await generateResponse(message, context, provider, model);
    res.json({ reply });
  } catch (error) {
    console.error("❌ Error in /chatbot:", error.message);
    res.status(500).json({ error: "An error occurred while processing your request." });
  }
});

// 🚀 **Start the server**
app.listen(PORT, () => {
  console.log(`✅ Server running at: http://localhost:${PORT}`);
});
