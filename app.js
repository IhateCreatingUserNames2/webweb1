// app.js
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables

const app = express();

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the root folder ****** ITS THE ROOT FOLDER THE CORRECT 
app.use(express.static(path.resolve(__dirname)));

// Load environment variables
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'bluew';
const PINECONE_BASE_URL = 'https://prod-1-data.ke.pinecone.io';

// ===============================
// CHAT API ENDPOINT
// ===============================
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  try {
    const response = await axios.post(
      `${PINECONE_BASE_URL}/assistant/chat/${ASSISTANT_NAME}/chat/completions`,
      {
        messages: [{ role: 'user', content: message }],
        stream: false,
        model: 'gpt-4o',
      },
      {
        headers: {
          'Api-Key': PINECONE_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Chat API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Chat request failed' });
  }
});

// ===============================
// FILE UPLOAD ENDPOINT
// ===============================

// Configure multer to store uploaded files temporarily in the "uploads" folder
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
  fileFilter: (req, file, cb) => {
    // Allow only PDF and plain text files
    const allowedTypes = ['application/pdf', 'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and TXT files are allowed.'));
    }
  },
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filePath = req.file.path;
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath), req.file.originalname);

    const uploadUrl = `${PINECONE_BASE_URL}/assistant/files/${ASSISTANT_NAME}`;
    const response = await axios.post(uploadUrl, formData, {
      headers: {
        'Api-Key': PINECONE_API_KEY,
        ...formData.getHeaders(),
      },
    });

    // Delete the temporary file after upload
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting temporary file:', err);
    });

    res.json(response.data);
  } catch (error) {
    console.error('File Upload Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'File upload failed' });
  }
});

// ===============================
// START THE SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
