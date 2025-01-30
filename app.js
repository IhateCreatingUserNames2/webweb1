const express = require("express");
const bodyParser = require("body-parser");
const { Pinecone } = require("@pinecone-database/pinecone"); // Use Pinecone as per backup
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const csvParser = require("csv-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys
const MINI_MAX_API_KEY = process.env.MiniMax_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Pinecone Configuration
const PINECONE_HOST_BLUEW = "https://bluew-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Host for BlueW index
const PINECONE_HOST_BLUEW2 = "https://bluew2-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Host for BlueW2 index
const INDEX_NAME_BLUEW = "bluew"; // Index for dense vector search
const INDEX_NAME_BLUEW2 = "bluew2"; // Index for hybrid (sparse-dense) search

const UPLOADS_DIR = path.join(__dirname, "uploads"); // Directory for uploaded files

// Allowed OpenAI models
const ALLOWED_MODELS = ["gpt-4o", "chatgpt-4o-latest", "o1"];

// Check for required API keys
if (!PINECONE_API_KEY || !OPENAI_API_KEY || !MINI_MAX_API_KEY) {
  console.error("❌ Missing API keys. Set them in the environment variables.");
  process.exit(1);
}

// Initialize Pinecone clients
const pineconeBlueW = new Pinecone({ apiKey: PINECONE_API_KEY });

const pineconeBlueW2 = new Pinecone({ apiKey: PINECONE_API_KEY });

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
 * ✅ Fetch context from stored files
 * Scans .txt and .csv files in /uploads/ for relevant content based on the user's message.
 * @param {string} message - The user's input message.
 * @returns {string|null} - Combined relevant context or null if none found.
 */
async function fetchFileContext(message) {
  try {
    let relevantContext = [];

    // Ensure the uploads directory exists
    if (!fs.existsSync(UPLOADS_DIR)) {
      console.warn(`⚠️ Uploads directory not found at ${UPLOADS_DIR}. Skipping file-based context retrieval.`);
      return null;
    }

    // Read all .txt files
    const txtFiles = fs.readdirSync(UPLOADS_DIR).filter((file) => file.endsWith(".txt"));
    for (const file of txtFiles) {
      const filePath = path.join(UPLOADS_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");

      // Simple keyword search (case-insensitive)
      if (content.toLowerCase().includes(message.toLowerCase())) {
        const excerpt = content.length > 500 ? content.substring(0, 500) + "..." : content;
        relevantContext.push(`📌 From ${file}: ${excerpt}`);
      }
    }

    // Read all .csv files
    const csvFiles = fs.readdirSync(UPLOADS_DIR).filter((file) => file.endsWith(".csv"));
    for (const file of csvFiles) {
      const filePath = path.join(UPLOADS_DIR, file);
      const csvData = [];

      // Parse CSV asynchronously
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on("data", (row) => {
            const rowContent = JSON.stringify(row).toLowerCase();
            if (rowContent.includes(message.toLowerCase())) {
              csvData.push(JSON.stringify(row));
            }
          })
          .on("end", () => {
            if (csvData.length) {
              const excerpts = csvData.slice(0, 5).join("\n");
              relevantContext.push(`📌 From ${file}:\n${excerpts}`);
            }
            resolve();
          })
          .on("error", (err) => {
            console.error(`❌ Error reading CSV file ${file}:`, err.message);
            reject(err);
          });
      });
    }

    return relevantContext.length ? relevantContext.join("\n\n") : null;
  } catch (error) {
    console.error("❌ Error in fetchFileContext:", error.message);
    return null;
  }
}

/**
 * 🛠️ Fetch relevant context from Pinecone indexes and uploaded files
 * @param {string} message - The user's input message.
 * @returns {string|null} - Combined relevant context or null if none found.
 */
async function fetchContext(message) {
  try {
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

    // 🔍 Query Pinecone BlueW (Dense Vector Search)
    const pineconeResponseBlueW = await indexBlueW.query({
      vector: queryVector,
      topK: 15,
      includeMetadata: true,
      includeValues: true, // ✅ Ensure both Dense & Sparse embeddings are retrieved
    });

    console.log("🔍 Pinecone BlueW Raw Response:", JSON.stringify(pineconeResponseBlueW, null, 2));

    // 🏆 **Lowered threshold to include more results**
    let relevantMatches = pineconeResponseBlueW.matches
      .filter(match => match.score > 0.05) // 🔥 Allow scores above 0.05
      .map(match => match.metadata.text);

    console.log("📌 Relevant Context Found:", relevantMatches);

    // 🚀 **Dynamically adjust filtering**
    if (relevantMatches.length === 0 && pineconeResponseBlueW.matches.length > 0) {
      console.warn("⚠️ No high-score matches found, but some low-score results exist.");
      relevantMatches = pineconeResponseBlueW.matches.map(match => match.metadata.text); // Fallback to all results
    }

    // Fetch context from files
    const fileContext = await fetchFileContext(message);

    // Combine contexts with separators
    const pineconeContext = [
      "### 📌 Dense Vector Context (BlueW):",
      relevantMatches.length ? relevantMatches.join("\n") : "No relevant context found.",
      "### 📌 Hybrid Search Context (BlueW2):",
      "No relevant hybrid context found.", // Placeholder
    ].join("\n\n");

    const combinedContext = fileContext
      ? `${pineconeContext}\n\n### 📂 File-based Context:\n${fileContext}`
      : pineconeContext;

    return combinedContext.length ? combinedContext : null;
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

  const MAX_CONTEXT_LENGTH = 2000;
  const trimmedContext = context ? context.substring(0, MAX_CONTEXT_LENGTH) : "";

  let systemMessage = `
Você é Roberta, assistente virtual da BlueWidow Energia LTDA.
Forneça informações sobre inversores e geradores híbridos.
--- cálculo da potência da usina em KWP (quantidade de módulos):
consumo em kWh/mês dividido por (5.2 (irradiação Goiás) x 30 (dias de geração) x 0.8 (fator perda do sistema)).
  `;

  // 🛠️ **Use Pinecone and File-based Context if Available**
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
      chatHistory.push({ role: "assistant", content: openaiData.choices[0].message.content.trim() });
      return openaiData.choices[0].message.content.trim();
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

  if (!message || !provider) {
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
