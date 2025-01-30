const express = require("express");
const bodyParser = require("body-parser");
const { Pinecone } = require("@pinecone-database/pinecone");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys
const MINI_MAX_API_KEY = process.env.MiniMax_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_HOST_BLUEW = "https://bluew-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Host for bluew index
const PINECONE_HOST_BLUEW2 = "https://bluew2-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Host for bluew2 index
const INDEX_NAME_BLUEW = "bluew"; // Index for dense vector search
const INDEX_NAME_BLUEW2 = "bluew2"; // Index for hybrid (sparse-dense) search

// Allowed OpenAI models
const ALLOWED_MODELS = ["gpt-4o", "chatgpt-4o-latest", "o1"];

if (!PINECONE_API_KEY || !OPENAI_API_KEY || !MINI_MAX_API_KEY) {
  console.error("❌ Missing API keys. Set them in the environment variables.");
  process.exit(1);
}

// Initialize Pinecone clients
const pineconeBlueW = new Pinecone({ apiKey: PINECONE_API_KEY });
const pineconeBlueW2 = new Pinecone({ apiKey: PINECONE_API_KEY });

app.use(bodyParser.json());
app.use(express.static(__dirname));

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Chat history storage
const chatHistory = [];

// 🛠️ **Fetch relevant context from both Pinecone indexes**
async function fetchContext(message) {
  try {
    // Initialize indexes
    const indexBlueW = pineconeBlueW.index(INDEX_NAME_BLUEW, PINECONE_HOST_BLUEW);
    const indexBlueW2 = pineconeBlueW2.index(INDEX_NAME_BLUEW2, PINECONE_HOST_BLUEW2);

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

    // 🔍 Query BlueW (Dense Vector Search)
    const pineconeResponseBlueW = await indexBlueW.query({
      vector: queryVector,
      topK: 15, // Adjust based on your needs
      includeMetadata: true,
      includeValues: false, // Set to false if you don't need the vector values
    });

    console.log("🔍 Pinecone BlueW Raw Response:", JSON.stringify(pineconeResponseBlueW, null, 2));

    // 🔍 Query BlueW2 (Hybrid Search)
    // Note: Pinecone's Node.js client currently supports only dense vectors for querying.
    // To perform hybrid search, use the REST API directly.
    const pineconeResponseBlueW2 = await fetch("https://bluew2-xek6roj.svc.aped-4627-b74a.pinecone.io/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": PINECONE_API_KEY,
      },
      body: JSON.stringify({
        vector: queryVector,
        topK: 5, // Adjust based on your needs
        includeMetadata: true,
        includeValues: false,
        sparseVector: {
          // Define your sparse vector here if needed
          // For example:
          // indices: [10, 45, 16],
          // values: [0.5, 0.5, 0.2]
          indices: [], // Replace with actual indices if available
          values: [] // Replace with actual values if available
        }
      }),
    });

    const hybridData = await pineconeResponseBlueW2.json();
    console.log("🔍 Pinecone BlueW2 Raw Response (Hybrid Search):", JSON.stringify(hybridData, null, 2));

    // 🏆 **Filter matches based on score**
    let relevantMatchesBlueW = pineconeResponseBlueW.matches
      .filter(match => match.score > 0.4) // Example threshold for BlueW
      .map(match => match.metadata.text);

    console.log("📌 Relevant Context Found (BlueW):", relevantMatchesBlueW);

    // Handle hybrid search results
    let relevantMatchesBlueW2 = hybridData.matches
      .filter(match => match.score > 0.1) // Example threshold for BlueW2
      .map(match => match.metadata.text);

    console.log("📌 Relevant Context Found (BlueW2 - Hybrid):", relevantMatchesBlueW2);

    // 🚀 **Combine contexts with separators**
    const combinedContext = [
      "### 📌 Dense Vector Context (BlueW):",
      relevantMatchesBlueW.length ? relevantMatchesBlueW.join("\n") : "No relevant context found.",
      "### 📌 Hybrid Search Context (BlueW2):",
      relevantMatchesBlueW2.length ? relevantMatchesBlueW2.join("\n") : "No relevant hybrid context found."
    ].join("\n\n");

    return combinedContext.length ? combinedContext : null;
  } catch (error) {
    console.error("❌ Error in fetchContext:", error.message);
    return null;
  }
}

// 🤖 **Generate response using OpenAI**
async function generateResponse(message, context, provider, model) {
  chatHistory.push({ role: "user", content: message });

  if (chatHistory.length > 6) {
    chatHistory.splice(0, 2);
  }

  const MAX_CONTEXT_LENGTH = 2000;
  const trimmedContext = context ? context.substring(0, MAX_CONTEXT_LENGTH) : "";

  let systemMessage = `
Você é Roberta, assistente virtual da BlueWidow Energia LTDA.
Forneça informações sobre inversores e geradores híbridos.
  `;

  // 🛠️ **Use Pinecone Context if Available**
  if (trimmedContext) {
    systemMessage += `
### 📌 Informações Recuperadas:
${trimmedContext}

✅ Use these information as the basis for the response. If necessary, ask for more details from the user.
    `;
  } else {
    // 🛠️ **Fallback: Allow OpenAI to answer freely**
    systemMessage += `
🔍 Nenhuma informação específica foi encontrada no banco de dados.
💡 Use seu conhecimento geral para responder de forma útil ao usuário.
    `;
  }

  systemMessage += `
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
          { role: "user", content: message },
        ],
        max_tokens: 1500,
        temperature: 0.7,
      }),
    });

    const openaiData = await chatResponse.json();
    console.log("💬 OpenAI Response:", JSON.stringify(openaiData, null, 2));

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
    let context = await fetchContext(message);

    // 🛠️ **Ensure AI Always Responds**
    if (!context) {
      context = null;
    }

    const reply = await generateResponse(message, context, provider, model);
    res.json({ reply });
  } catch (error) {
    console.error("❌ Error in /chatbot:", error.message);
    res.status(500).json({ error: "An error occurred while processing your request." });
  }
});

// 🚀 **Start the server**
app.listen(PORT, () => {
  console.log(`🚀 Server running at: http://localhost:${PORT}`);
});
