// server.js

require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const csvParser = require("csv-parser");
const { Vector } = require("vectorious");

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Configuration
const UPLOADS_DIR = path.join(__dirname, "uploads"); // Directory for uploaded files
const ALLOWED_MODELS = ["gpt-4o", "chatgpt-4o-latest", "o1"];
const MAX_CONTEXT_LENGTH = 2000;
const EMBEDDING_MODEL = "text-embedding-ada-002"; // Use a lightweight embedding model

// Middleware
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Chat history storage
const chatHistory = [];

// In-memory vector store
let vectorStore = [];

/**
 * 📂 Load and preprocess documents from uploads directory
 */
async function loadDocuments() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    console.warn(`⚠️ Uploads directory not found at ${UPLOADS_DIR}.`);
    return;
  }

  const txtFiles = fs.readdirSync(UPLOADS_DIR).filter((file) => file.endsWith(".txt"));
  const csvFiles = fs.readdirSync(UPLOADS_DIR).filter((file) => file.endsWith(".csv"));

  // Process .txt files
  for (const file of txtFiles) {
    const filePath = path.join(UPLOADS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    // Split content into chunks (e.g., 500 characters)
    const chunks = splitText(content, 500);
    for (const chunk of chunks) {
      vectorStore.push({ source: file, content: chunk, embedding: null });
    }
  }

  // Process .csv files
  for (const file of csvFiles) {
    const filePath = path.join(UPLOADS_DIR, file);
    await new Promise((resolve, reject) => {
      const rows = [];
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on("data", (row) => {
          rows.push(JSON.stringify(row));
        })
        .on("end", () => {
          // Split rows into chunks
          const chunks = splitText(rows.join(" "), 500);
          for (const chunk of chunks) {
            vectorStore.push({ source: file, content: chunk, embedding: null });
          }
          resolve();
        })
        .on("error", (err) => {
          console.error(`❌ Error reading CSV file ${file}:`, err.message);
          reject(err);
        });
    });
  }

  // Generate embeddings for all chunks
  await generateEmbeddingsForStore();
}

/**
 * ✂️ Split text into chunks of approximately `maxLength` characters
 * @param {string} text 
 * @param {number} maxLength 
 * @returns {string[]}
 */
function splitText(text, maxLength) {
  const regex = new RegExp(`.{1,${maxLength}}`, 'g');
  return text.match(regex) || [];
}

/**
 * 🔑 Generate embeddings for all documents in the vector store
 */
async function generateEmbeddingsForStore() {
  console.log("🧮 Generating embeddings for documents...");
  const batchSize = 1000; // Adjust based on OpenAI rate limits
  for (let i = 0; i < vectorStore.length; i += batchSize) {
    const batch = vectorStore.slice(i, i + batchSize);
    const texts = batch.map(doc => doc.content);
    const embeddings = await getEmbeddings(texts);
    for (let j = 0; j < batch.length; j++) {
      vectorStore[i + j].embedding = embeddings[j];
    }
    console.log(`✅ Generated embeddings for ${i + batch.length} / ${vectorStore.length} documents.`);
  }
  console.log("🎉 All embeddings generated.");
}

/**
 * 📡 Fetch embeddings from OpenAI
 * @param {string[]} texts 
 * @returns {number[][]}
 */
async function getEmbeddings(texts) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch embeddings: ${error}`);
  }

  const data = await response.json();
  return data.data.map(item => item.embedding);
}

/**
 * 📐 Compute cosine similarity between two vectors
 * @param {number[]} vecA 
 * @param {number[]} vecB 
 * @returns {number}
 */
function cosineSimilarity(vecA, vecB) {
  const a = new Vector(vecA);
  const b = new Vector(vecB);
  return a.dot(b) / (a.magnitude() * b.magnitude());
}

/**
 * 🔍 Retrieve top N relevant documents based on similarity
 * @param {number[]} queryEmbedding 
 * @param {number} topK 
 * @returns {Array}
 */
function retrieveRelevantDocuments(queryEmbedding, topK = 5) {
  const similarities = vectorStore.map(doc => ({
    ...doc,
    similarity: cosineSimilarity(queryEmbedding, doc.embedding),
  }));

  similarities.sort((a, b) => b.similarity - a.similarity);
  return similarities.slice(0, topK);
}

/**
 * ✅ Fetch context from stored files using embeddings
 * @param {string} message - The user's input message.
 * @returns {string|null} - Combined relevant context or null if none found.
 */
async function fetchContext(message) {
  try {
    // Generate embedding for the user message
    const embeddings = await getEmbeddings([message]);
    const queryEmbedding = embeddings[0];

    // Retrieve top 5 relevant documents
    const relevantDocs = retrieveRelevantDocuments(queryEmbedding, 5);

    if (!relevantDocs.length) {
      return null;
    }

    // Format the retrieved contexts
    const relevantContext = relevantDocs.map(doc => `📌 From ${doc.source}:\n${doc.content}`).join("\n\n");
    return relevantContext;
  } catch (error) {
    console.error("❌ Error in fetchContext:", error.message);
    return null;
  }
}

/**
 * 🤖 Generate response using OpenAI
 * @param {string} message - The user's input message.
 * @param {string|null} context - Combined relevant context.
 * @param {string} provider - The provider to use (e.g., 'openai').
 * @param {string} model - The OpenAI model to use.
 * @returns {string} - The generated response.
 */
async function generateResponse(message, context, provider, model) {
  chatHistory.push({ role: "user", content: message });

  // Maintain a maximum of 6 interactions
  if (chatHistory.length > 6) {
    chatHistory.splice(0, 2);
  }

  const trimmedContext = context ? context.substring(0, MAX_CONTEXT_LENGTH) : "";

  let systemMessage = `
Você é Roberta, assistente virtual da BlueWidow Energia LTDA.
Forneça informações sobre inversores e geradores híbridos.
--- cálculo da potência da usina em KWP (quantidade de módulos):
consumo em kWh/mês dividido por (5.2 (irradiação Goiás) x 30 (dias de geração) x 0.8 (fator perda do sistema)).
  `;

  // 🛠️ **Use File-based Context if Available**
  if (trimmedContext) {
    systemMessage += `
### 📌 Informações Recuperadas:
${trimmedContext}

✅ Use estas informações como base para a resposta. Se necessário, peça mais detalhes ao usuário.
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
      console.warn(`⚠️ Modelo inválido "${model}" selecionado. Defaulting to gpt-4o.`);
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
      const replyContent = openaiData.choices[0].message.content.trim();
      chatHistory.push({ role: "assistant", content: replyContent });
      return replyContent;
    }

    return "Nenhuma resposta gerada.";
  } else {
    throw new Error("Invalid provider selected.");
  }
}

/**
 * 📨 Chatbot API Endpoint
 * Receives user messages and returns chatbot responses.
 */
app.post("/chatbot", async (req, res) => {
  const { message, provider, model } = req.body;

  if (!message || !provider || !model) {
    return res.status(400).json({ error: "Message, provider, and model are required." });
  }

  try {
    const context = await fetchContext(message);
    const reply = await generateResponse(message, context, provider, model);
    res.json({ reply });
  } catch (error) {
    console.error("❌ Error in /chatbot:", error.message);
    res.status(500).json({ error: "Ocorreu um erro ao processar sua solicitação." });
  }
});

// 🚀 **Start the server and load documents**
app.listen(PORT, async () => {
  console.log(`🚀 Server running at: http://localhost:${PORT}`);
  try {
    await loadDocuments();
  } catch (error) {
    console.error("❌ Error loading documents:", error.message);
  }
});
