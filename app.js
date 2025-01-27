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
    maxContentLength: Infinity
  }
});
const openai = new OpenAIApi(configuration);

// Configure Pinecone
const pinecone = new PineconeClient();
pinecone.init({
  apiKey: process.env.PINECONE_API_KEY, // Set your Pinecone API key
  environment: 'us-east-1-aws', // Adjust if necessary
});
const indexName = 'bluew';
const pineconeIndex = pinecone.Index(indexName);

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory storage
let conversationHistory = []; // [{ user: 'User'/'Bot', message: '...' }, ...]

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Helper: Generate Embeddings and Upsert to Pinecone
async function generateAndStoreEmbeddings(fileName, fileText) {
  try {
    // Generate embeddings using OpenAI
    const response = await openai.createEmbedding({
      model: 'text-embedding-ada-002',
      input: fileText,
    });
    const embedding = response.data.data[0].embedding;

    // Upsert embedding to Pinecone
    await pineconeIndex.upsert({
      vectors: [{ id: fileName, values: embedding }],
    });

    console.log(`Embeddings for ${fileName} stored successfully.`);
  } catch (error) {
    console.error('Error generating/storing embeddings:', error.message);
  }
}

// Endpoint: Upload Files and Store Embeddings
app.post('/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  const file = req.files.file;
  const uploadDir = path.join(__dirname, 'uploads');

  // Create uploads folder if it doesn't exist
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const uploadPath = path.join(uploadDir, file.name);

  // Save file
  file.mv(uploadPath, async (err) => {
    if (err) {
      console.error('File upload error:', err);
      return res.status(500).send(err);
    }

    // Extract text from file
    let extractedText = '';
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const dataBuffer = fs.readFileSync(uploadPath);
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData.text;
      } else if (file.name.toLowerCase().endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: uploadPath });
        extractedText = result.value;
      } else {
        // Read plain text files
        extractedText = fs.readFileSync(uploadPath, 'utf8');
      }

      // Generate and store embeddings
      await generateAndStoreEmbeddings(file.name, extractedText);

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
  const { message, selectedFiles } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Retrieve embeddings for selected files
    const retrievedTexts = [];
    for (const fileName of selectedFiles) {
      const queryEmbedding = (
        await openai.createEmbedding({
          model: 'text-embedding-ada-002',
          input: message,
        })
      ).data.data[0].embedding;

      const queryResponse = await pineconeIndex.query({
        topK: 1,
        includeMetadata: true,
        vector: queryEmbedding,
      });

      const closestMatch = queryResponse.matches?.[0];
      if (closestMatch) {
        retrievedTexts.push(closestMatch.metadata.text);
      }
    }

    // Construct prompt
    const context = retrievedTexts.join('\n\n---\n\n');
    const prompt = `
CONTEXT (from relevant files):
${context}

CHAT HISTORY:
${conversationHistory.map((c) => `${c.user}: ${c.message}`).join('\n')}

USER: ${message}
BOT:
`;

    // Call OpenAI API
    const response = await openai.createCompletion({
      model: 'gpt-4o',
      prompt: prompt,
      max_tokens: 2048,
      temperature: 0.7,
    });

    const botReply = response.data?.choices?.[0]?.text?.trim() || 'No response generated.';

    // Update conversation history
    conversationHistory.push({ user: 'User', message });
    conversationHistory.push({ user: 'Bot', message: botReply });

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error in chatbot:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Error processing the message.' });
  }
});

// Endpoint: List Files
app.get('/files', async (req, res) => {
  try {
    const fileList = (await pineconeIndex.describeIndexStats({})).namespaces;
    const files = Object.keys(fileList || {}).map((fileName) => ({ name: fileName }));
    res.json(files);
  } catch (error) {
    console.error('Error listing files:', error.message);
    res.status(500).send('Error listing files.');
  }
});

// Endpoint: Delete File
app.delete('/delete-file', async (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ success: false, message: 'File name is required.' });
  }

  try {
    await pineconeIndex.delete({ ids: [name] });
    res.json({ success: true, message: `File ${name} deleted successfully.` });
  } catch (error) {
    console.error('Error deleting file:', error.message);
    res.status(500).json({ success: false, message: 'Error deleting file.' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
