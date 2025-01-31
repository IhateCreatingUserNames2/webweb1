// app.js

require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const csvParser = require("csv-parser");
const { QdrantClient, models } = require("@qdrant/js-client-rest"); // Qdrant Client
const axios = require("axios"); // For HTTP requests
const MarkdownIt = require('markdown-it'); // For rendering Markdown

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Markdown renderer
const md = new MarkdownIt();

// API Keys and URLs
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

// Configuration
const UPLOADS_DIR = path.join(__dirname, "uploads"); // Directory for uploaded files
const COLLECTION_NAME = "chatbot_collection"; // Qdrant collection name
const ALLOWED_MODELS = ["gpt-4o", "chatgpt-4o-latest", "o1"];
const MAX_CONTEXT_LENGTH = 2000;
const EMBEDDING_MODEL = "text-embedding-ada-002"; // Use a lightweight embedding model

// Initialize Qdrant Client
const qdrant = new QdrantClient({
  url: QDRANT_URL, // Qdrant Cloud endpoint
  apiKey: QDRANT_API_KEY, // Qdrant Cloud API key
});

// Middleware
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Chat history storage
const chatHistory = [];

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

  // Initialize Qdrant collection
  await initializeQdrantCollection();

  // Process .txt files
  for (const file of txtFiles) {
    const isEmbedded = await checkIfFileEmbedded(file);
    if (!isEmbedded) {
      console.log(`📄 Processing new file: ${file}`);
      const filePath = path.join(UPLOADS_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");
      // Split content into chunks (e.g., 500 characters)
      const chunks = splitText(content, 500);
      for (const [index, chunk] of chunks.entries()) {
        await addDocumentToQdrant(file, chunk, index);
      }
      console.log(`✅ Completed embedding for file: ${file}`);
    } else {
      console.log(`ℹ️ File already embedded: ${file}`);
    }
  }

  // Process .csv files
  for (const file of csvFiles) {
    const isEmbedded = await checkIfFileEmbedded(file);
    if (!isEmbedded) {
      console.log(`📄 Processing new CSV file: ${file}`);
      const filePath = path.join(UPLOADS_DIR, file);
      await new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on("data", (row) => {
            rows.push(JSON.stringify(row));
          })
          .on("end", async () => {
            // Split rows into chunks
            const chunks = splitText(rows.join(" "), 500);
            for (const [index, chunk] of chunks.entries()) {
              await addDocumentToQdrant(file, chunk, index);
            }
            console.log(`✅ Completed embedding for CSV file: ${file}`);
            resolve();
          })
          .on("error", (err) => {
            console.error(`❌ Error reading CSV file ${file}:`, err.message);
            reject(err);
          });
      });
    } else {
      console.log(`ℹ️ CSV file already embedded: ${file}`);
    }
  }

  console.log("🎉 All documents processed and embedded into Qdrant.");
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
 * 🔑 Initialize Qdrant collection
 */
async function initializeQdrantCollection() {
  try {
    // Check if collection exists
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some(col => col.name === COLLECTION_NAME);
    if (exists) {
      console.log(`✅ Qdrant collection "${COLLECTION_NAME}" already exists.`);
      return;
    }

    // Create collection
    await qdrant.createCollection({
      collection_name: COLLECTION_NAME,
      vectors: new models.VectorParams({
        size: 1536, // Size of ada-002 embeddings
        distance: models.Distance.Cosine
      }),
    });
    console.log(`✅ Qdrant collection "${COLLECTION_NAME}" created.`);
  } catch (error) {
    console.error("❌ Error initializing Qdrant collection:", error.message);
    throw error;
  }
}

/**
 * 🔍 Check if a file has already been embedded
 * @param {string} fileName 
 * @returns {boolean}
 */
async function checkIfFileEmbedded(fileName) {
  try {
    const filter = new models.Filter({
      must: [
        new models.FieldCondition({
          key: "source",
          match: {
            value: fileName
          }
        })
      ]
    });

    const searchResult = await qdrant.scroll({
      collection_name: COLLECTION_NAME,
      filter: filter,
      limit: 1, // We just need to know if at least one point exists
    });

    return searchResult.result.length > 0;
  } catch (error) {
    console.error(`❌ Error checking if file ${fileName} is embedded:`, error.message);
    return false;
  }
}

/**
 * 🔑 Add a document to Qdrant
 * @param {string} source - File name
 * @param {string} content - Chunked content
 * @param {number} index - Chunk index
 */
async function addDocumentToQdrant(source, content, index) {
  try {
    const embeddings = await getEmbeddings([content]);
    const vector = embeddings[0];

    // Create a unique ID for the document based on source and index
    const id = `${source}-${index}`;

    // Add to Qdrant
    await qdrant.upsert({
      collection_name: COLLECTION_NAME,
      points: [
        new models.PointStruct({
          id: id,
          vector: vector,
          payload: {
            source: source,
            content: content
          }
        })
      ]
    });

    console.log(`✅ Added document ID ${id} from ${source}`);
  } catch (error) {
    console.error(`❌ Error adding document ID ${source}-${index} to Qdrant:`, error.message);
  }
}

/**
 * 🔑 Generate a unique ID
 * @returns {string}
 */
function generateUniqueId() {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * 📡 Fetch embeddings from OpenAI
 * @param {string[]} texts 
 * @returns {number[][]}
 */
async function getEmbeddings(texts) {
  try {
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
  } catch (error) {
    console.error("❌ Error fetching embeddings from OpenAI:", error.message);
    throw error;
  }
}

/**
 * ✅ Fetch context using Qdrant's AI Search
 * @param {string} message - The user's input message.
 * @returns {string|null} - Combined relevant context or null if none found.
 */
async function fetchContext(message) {
  try {
    // Generate embedding for the user message
    const embeddings = await getEmbeddings([message]);
    const queryEmbedding = embeddings[0];

    console.log("🔍 Query Embedding:", queryEmbedding);

    // Query Qdrant for similar vectors
    const searchResult = await qdrant.search({
      collection_name: COLLECTION_NAME,
      vector: queryEmbedding,
      top: 5,
      with_payload: true,
    });

    console.log("🔍 Search Result:", JSON.stringify(searchResult, null, 2));

    const results = searchResult.result;

    if (!results.length) {
      return null;
    }

    // Format the retrieved contexts
    const relevantContext = results.map(doc => `📌 **Fonte:** ${doc.payload.source}\n${doc.payload.content}`).join("\n\n");
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

  // 🛠️ **Use AI Search Context if Available**
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

    try {
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
    } catch (error) {
      console.error("❌ Error generating OpenAI response:", error.message);
      return "Ocorreu um erro ao gerar a resposta.";
    }
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

  if (!message || !provider || (provider === "openai" && !model)) {
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

/**
 * 🏁 Start the server and load documents
 */
app.listen(PORT, async () => {
  console.log(`🚀 Server running at: http://localhost:${PORT}`);
  try {
    await loadDocuments();
  } catch (error) {
    console.error("❌ Error loading documents:", error.message);
  }
});
