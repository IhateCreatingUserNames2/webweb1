// app.js
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Carrega as variáveis de ambiente

const app = express();

// Middleware para parse de JSON e URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve arquivos estáticos a partir do diretório raiz
app.use(express.static(path.resolve(__dirname)));

// Variáveis de ambiente
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'bluew';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Chave padrão da OpenAI para gerar tokens efêmeros
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
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // Limite de 10 MB
  fileFilter: (req, file, cb) => {
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

    // Remove o arquivo temporário
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
// AUDIO UPLOAD (VOICE) ENDPOINT
// ===============================
const audioUpload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // Limite de 10 MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/ogg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  },
});

app.post('/api/voice', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  try {
    const filePath = req.file.path;
    // Converte o arquivo de áudio para Base64
    const audioBase64 = fs.readFileSync(filePath, { encoding: 'base64' });
    // Remove o arquivo temporário
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting temporary audio file:', err);
    });

    // Cria uma sessão efêmera chamando a API da OpenAI
    const sessionResponse = await axios.post(
      "https://api.openai.com/v1/realtime/sessions",
      {
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "verse",
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        }
      }
    );
    const ephemeralKey = sessionResponse.data.client_secret.value;
    console.log("Ephemeral Key obtida para envio de áudio:", ephemeralKey);

    // Cria o payload do evento para enviar o áudio completo como input
    const eventPayload = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_audio",
            audio: audioBase64,
          }
        ]
      }
    };

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    // Envia o evento para a API Realtime da OpenAI
    const eventResponse = await axios.post(
      `${baseUrl}?model=${model}`,
      eventPayload,
      {
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/json",
        }
      }
    );

    // Supomos que a resposta contenha as propriedades 'transcription' e 'audioResponse' (em Base64)
    res.json(eventResponse.data);
  } catch (error) {
    console.error('Voice API Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Voice processing failed' });
  }
});

// ===============================
// REALTIME ENDPOINTS (para WebRTC)
// ===============================
app.get('/realtime', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'realtime.html'));
});

app.get('/session', async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "verse",
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error generating ephemeral token:', error);
    res.status(500).json({ error: 'Failed to generate session token' });
  }
});

// ===============================
// START THE SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
