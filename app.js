require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { Configuration, OpenAIApi } = require('openai');
const { PineconeClient } = require('@pinecone-database/pinecone');

// Configure OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
  baseOptions: {
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  },
});
const openai = new OpenAIApi(configuration);

// Configure Pinecone
(async () => {
  const pinecone = new PineconeClient();
  await pinecone.init({
    apiKey: process.env.PINECONE_API_KEY, // Your Pinecone API key
    environment: 'us-east-1-aws', // Adjust to your environment
  });

module.exports = pinecone;  
const indexName = 'bluew';
const pineconeIndex = pinecone.Index(indexName);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Helper: Chunk Text
function chunkText(text, chunkSize = 500) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

// Helper: Generate and Store Embeddings
async function generateAndStoreEmbeddings(textChunks, metadata) {
  try {
    for (const [index, chunk] of textChunks.entries()) {
      const response = await openai.createEmbedding({
        model: 'text-embedding-3-large',
        input: chunk,
      });
      const embedding = response.data.data[0].embedding;

      await pineconeIndex.upsert({
        vectors: [
          {
            id: `${metadata.id}-chunk-${index}`,
            values: embedding,
            metadata: { ...metadata, chunk: chunk },
          },
        ],
      });
    }
    console.log(`Embeddings stored for ${metadata.id}`);
  } catch (error) {
    console.error('Error storing embeddings:', error.message);
  }
}

// Endpoint: Upload Files
app.post('/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  const file = req.files.file;
  const uploadDir = path.join(__dirname, 'uploads');

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const uploadPath = path.join(uploadDir, file.name);

  file.mv(uploadPath, async (err) => {
    if (err) {
      console.error('File upload error:', err);
      return res.status(500).send(err);
    }

    try {
      let extractedText = '';
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const dataBuffer = fs.readFileSync(uploadPath);
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData.text;
      } else if (file.name.toLowerCase().endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: uploadPath });
        extractedText = result.value;
      } else {
        extractedText = fs.readFileSync(uploadPath, 'utf8');
      }

      const textChunks = chunkText(extractedText, 500); // Chunk text
      const metadata = { id: file.name, type: 'file' };

      await generateAndStoreEmbeddings(textChunks, metadata);

      res.json({
        message: 'File uploaded and processed successfully',
        fileName: file.name,
      });
    } catch (parseError) {
      console.error('Error extracting text:', parseError);
      res.status(500).send('Error processing file.');
    }
  });
});

// Endpoint: Chat with RAG
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Generate embedding for user message
    const queryEmbedding = (
      await openai.createEmbedding({
        model: 'text-embedding-3-large',
        input: message,
      })
    ).data.data[0].embedding;

    // Retrieve relevant contexts from Pinecone
    const fileResults = await pineconeIndex.query({
      topK: 5,
      includeMetadata: true,
      vector: queryEmbedding,
      filter: { type: 'file' },
    });

    const conversationResults = await pineconeIndex.query({
      topK: 5,
      includeMetadata: true,
      vector: queryEmbedding,
      filter: { type: 'conversation' },
    });

    // Combine relevant contexts
    const contexts = [
      ...fileResults.matches.map((match) => match.metadata.chunk),
      ...conversationResults.matches.map((match) => match.metadata.chunk),
    ].join('\n\n---\n\n');

    // Construct prompt
    const prompt = `
CONTEXT:
${contexts}

USER QUESTION:
${message}

BOT RESPONSE:
`;

    // Call OpenAI API
    const response = await openai.createCompletion({
      model: 'gpt-4o',
      prompt: prompt,
      max_tokens: 1500,
      temperature: 0.7,
    });

    const botReply = response.data?.choices?.[0]?.text?.trim() || 'No response generated.';

    // Store conversation in Pinecone
    await generateAndStoreEmbeddings([message], { id: `user-${Date.now()}`, type: 'conversation' });
    await generateAndStoreEmbeddings([botReply], { id: `bot-${Date.now()}`, type: 'conversation' });

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error in chatbot:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Error processing the message.' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
