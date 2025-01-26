// Import required modules
const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const { Configuration, OpenAIApi } = require('openai');

// Initialize the app
const app = express();
const PORT = process.env.PORT || 3000;

// Configure OpenAI
const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY, // Set your OpenAI API key in the environment variables
  })
);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());
app.use(express.static('public'));

// Memory for conversation history and uploaded files
let conversationHistory = [];
let uploadedFiles = [];

// Chatbot endpoint
app.post('/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Create prompt with conversation history
    const prompt = conversationHistory
      .map((entry) => `${entry.user}: ${entry.message}`)
      .join('\n') + `\nUser: ${message}\nBot:`;

    // Send prompt to OpenAI
    const response = await openai.createCompletion({
      model: 'o1', // Change to 'gpt-4' if needed
      prompt,
      max_tokens: 150,
      temperature: 0.7,
    });

    const botReply = response.data.choices[0].text.trim();

    // Update conversation history
    conversationHistory.push({ user: 'User', message });
    conversationHistory.push({ user: 'Bot', message: botReply });

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error in chatbot:', error);
    res.status(500).json({ error: 'Error processing the message' });
  }
});

// Upload endpoint
app.post('/upload', (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  const file = req.files.file;
  const uploadPath = path.join(__dirname, 'uploads', file.name);

  // Save file
  file.mv(uploadPath, (err) => {
    if (err) {
      console.error('File upload error:', err);
      return res.status(500).send(err);
    }

    uploadedFiles.push({ name: file.name, path: uploadPath });
    res.json({ message: 'File uploaded successfully', fileName: file.name });
  });
});

// Fetch uploaded files
app.get('/files', (req, res) => {
  res.json(uploadedFiles);
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Create folders for uploads
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}
