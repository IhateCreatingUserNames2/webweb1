require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;

// Se você tiver um endpoint ou1 custom (exemplo fictício):
const O1_API_URL = process.env.O1_API_URL || 'https://api.seu-o1.com/v1/completions';
const O1_API_KEY = process.env.O1_API_KEY || 'coloque_sua_chave_aqui';

// Para armazenar o texto extraído dos arquivos
let docsTexts = {}; 
// Para armazenar histórico de mensagens (user -> bot)
let conversationHistory = [];

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Endpoint do chatbot
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Concatena todo o texto dos arquivos em um grande string 
    // (em produção, deve-se usar chunking + embeddings, mas aqui é simples).
    const allDocsText = Object.values(docsTexts).join('\n\n---\n\n');

    // Monta prompt com o contexto
    const prompt = `
CONTEXT (from uploaded files):
${allDocsText}

CHAT HISTORY:
${conversationHistory.map((c) => `${c.user}: ${c.message}`).join('\n')}

USER: ${message}
BOT: 
`;

    // Chama a API 'o1' via axios
    const response = await axios.post(
      O1_API_URL,
      {
        model: 'o1',  // se você tiver variações, ex. 'o1-mini-2024-09-12'
        prompt: prompt,
        max_tokens: 200,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${O1_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Obtenha a resposta da estrutura que sua API retorna
    const botReply = response.data?.choices?.[0]?.text?.trim() || 
                     'Desculpe, não foi possível obter resposta.';

    // Armazena no histórico
    conversationHistory.push({ user: 'User', message });
    conversationHistory.push({ user: 'Bot', message: botReply });

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error in chatbot:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error processing the message' });
  }
});

// Endpoint para upload de arquivos
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

  // Salvar o arquivo fisicamente
  file.mv(uploadPath, async (err) => {
    if (err) {
      console.error('File upload error:', err);
      return res.status(500).send(err);
    }

    // Extração de texto
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
        // Tenta ler como texto puro
        extractedText = fs.readFileSync(uploadPath, 'utf8');
      }
    } catch (parseError) {
      console.error('Error extracting text:', parseError);
      // Se quiser, pode continuar com extração vazia
      extractedText = '';
    }

    // Armazena em memória
    docsTexts[file.name] = extractedText;

    res.json({ message: 'File uploaded and parsed successfully', fileName: file.name });
  });
});

// Endpoint para listar arquivos
app.get('/files', (req, res) => {
  const list = Object.keys(docsTexts).map((fileName) => ({ name: fileName }));
  res.json(list);
});

// Serve index.html (frontend)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Sobe servidor
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
