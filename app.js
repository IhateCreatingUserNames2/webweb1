require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// MiniMax API Configuration
const MINIMAX_API_URL = 'https://api.minimaxi.chat/v1/text/chatcompletion_v2';
const MiniMax_API_KEY = process.env.MiniMax_API_KEY; // Set in your .env file

// Simple in-memory storage
let docsTexts = {}; // { fileName: extractedText, ... }
let conversationHistory = []; // [{ role: 'user'/'assistant', content: '...' }, ...]

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Chatbot endpoint
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Concatenate text from uploaded files (truncate if needed)
    const MAX_TEXT_LENGTH = 50000; // Adjust as per MiniMax's token limit
    const allDocsText = Object.values(docsTexts)
      .join('\n\n---\n\n')
      .slice(0, MAX_TEXT_LENGTH);

    // Create the conversation history with context from files
    const messages = [
      {
        role: 'system',
        name: 'MM Intelligent Assistant',
        content:
          'MM Intelligent Assistant is a large language model that processes user-provided context and conversation history to generate responses.',
      },
      ...conversationHistory,
      {
        role: 'user',
        name: 'user',
        content: `Context from files:\n${allDocsText}\n\nUser's question: ${message}`,
      },
    ];

    // Call MiniMax API
    const response = await axios.post(
      MINIMAX_API_URL,
      {
        model: 'MiniMax-Text-01', // Use the preferred MiniMax model
        messages: messages,
        max_tokens: 950000, // Adjust as needed
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${MiniMax_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Get the bot's response
    const botReply =
      response.data.choices?.[0]?.message?.content ||
      'Sorry, no response was generated.';

    // Update conversation history
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: botReply });

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error in chatbot:', error.response?.data || error.message);
    res
      .status(500)
      .json({ error: 'Error processing the message or connecting to MiniMax' });
  }
});

// File upload endpoint
app.post('/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  const file = req.files.file;
  const uploadDir = path.join(__dirname, 'uploads');

  // Create uploads directory if not exists
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const uploadPath = path.join(uploadDir, file.name);

  // Save the file
  file.mv(uploadPath, async (err) => {
    if (err) {
      console.error('File upload error:', err);
      return res.status(500).send(err);
    }

    let extractedText = '';
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const pdfData = await pdfParse(fs.readFileSync(uploadPath));
        extractedText = pdfData.text;
      } else if (file.name.toLowerCase().endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: uploadPath });
        extractedText = result.value;
      } else {
        extractedText = fs.readFileSync(uploadPath, 'utf8');
      }
    } catch (parseError) {
      console.error('Error extracting text:', parseError);
    }

    // Store extracted text
    docsTexts[file.name] = extractedText;

    res.json({
      message: 'File uploaded and parsed successfully',
      fileName: file.name
