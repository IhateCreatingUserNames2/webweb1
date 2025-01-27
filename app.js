require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const bodyParser = require('body-parser');
const { Configuration, OpenAIApi } = require('openai');
const { Pinecone } = require('@pinecone-database/pinecone');

// Environment variables
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_HOST = "https://bluew-xek6roj.svc.aped-4627-b74a.pinecone.io"; // Pinecone host
const INDEX_NAME = "bluew";

// Validate API keys
if (!PINECONE_API_KEY || !OPENAI_API_KEY) {
  console.error("Error: PINECONE_API_KEY or OPENAI_API_KEY is not set. Please configure them.");
  process.exit(1);
}

// Initialize Pinecone client
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

// Configure OpenAI
const configuration = new Configuration({ apiKey: OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

// Express setup
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(fileUpload());
app.use(express.static(__dirname));

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Function to initialize Pinecone index
async function initIndex() {
  try {
    const index = pinecone.index(INDEX_NAME, PINECONE_HOST);
    console.log(`Connected to Pinecone index: ${INDEX_NAME}`);
    return index;
  } catch (error) {
    console.error("Error initializing Pinecone index:", error.message);
    process.exit(1);
  }
}

let pineconeIndex;

// Initialize Pinecone index
(async () => {
  pineconeIndex = await initIndex();
})();

// Helper: Chunk text into smaller parts
function chunkText(text, chunkSize = 500) {
  const sentences = text.split(/(?<=\.)\s+/);
  const chunks = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > chunkSize) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += ` ${sentence}`;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

// Helper: Generate and store embeddings in Pinecone
async function generateAndStoreEmbeddings(textChunks, metadata) {
  try {
    const vectors = []; // Collect vectors to batch upserts
    for (const [index, chunk] of textChunks.entries()) {
      const response = await openai.createEmbedding({
        model: "text-embedding-3-large",
        input: chunk,
      });
      const embedding = response.data.data[0].embedding;

      // Create vector object
      vectors.push({
        id: `${metadata.id}-chunk-${index}`,
        values: embedding,
        metadata: { ...metadata, chunk },
      });
    }

    // Upsert vectors in a single batch
    if (vectors.length > 0) {
      await pineconeIndex.upsert({ vectors });
      console.log(`Embeddings stored for ${metadata.id}`);
    } else {
      console.warn("No embeddings to store.");
    }
  } catch (error) {
    console.error("Error storing embeddings:", error.message);
  }
}

// Endpoint: File upload
app.post("/upload", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send("No file uploaded.");
  }

  const file = req.files.file;
  const uploadDir = path.join(__dirname, "uploads");

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const uploadPath = path.join(uploadDir, file.name);

  file.mv(uploadPath, async (err) => {
    if (err) {
      console.error("File upload error:", err);
      return res.status(500).send(err);
    }

    try {
      let extractedText = "";
      if (file.name.toLowerCase().endsWith(".pdf")) {
        const dataBuffer = fs.readFileSync(uploadPath);
        extractedText = (await pdfParse(dataBuffer)).text;
      } else if (file.name.toLowerCase().endsWith(".docx")) {
        extractedText = (await mammoth.extractRawText({ path: uploadPath })).value;
      } else {
        extractedText = fs.readFileSync(uploadPath, "utf8");
      }

      const textChunks = chunkText(extractedText, 1000);
      const metadata = { id: file.name, type: "file" };

      await generateAndStoreEmbeddings(textChunks, metadata);

      res.json({ message: "File uploaded and processed successfully", fileName: file.name });
    } catch (parseError) {
      console.error("Error extracting text:", parseError);
      res.status(500).send("Error processing file.");
    }
  });
});

// Endpoint: Chatbot with RAG
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const queryEmbedding = (
      await openai.createEmbedding({
        model: "text-embedding-3-large",
        input: message,
      })
    ).data.data[0].embedding;

    const queryResponse = await pineconeIndex.query({
      topK: 5,
      vector: queryEmbedding,
      includeMetadata: true,
    });

    if (!queryResponse.matches || queryResponse.matches.length === 0) {
      return res.json({ reply: "No relevant context found." });
    }

    const contexts = queryResponse.matches.map((match) => match.metadata.chunk).join("\n\n---\n\n");

    const prompt = `
CONTEXT:
${contexts}

USER QUESTION:
${message}

BOT RESPONSE:
`;

    const response = await openai.createCompletion({
      model: "gpt-4",
      prompt,
      max_tokens: 1500,
      temperature: 0.7,
    });

    const botReply = response.data.choices[0]?.text?.trim() || "No response generated.";

    // Store the conversation in Pinecone
    await generateAndStoreEmbeddings([message], { id: `user-${Date.now()}`, type: "conversation" });
    await generateAndStoreEmbeddings([botReply], { id: `bot-${Date.now()}`, type: "conversation" });

    res.json({ reply: botReply });
  } catch (error) {
    console.error("Error in chatbot:", error.message);
    res.status(500).json({ error: "Error processing the message." });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
