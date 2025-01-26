require('dotenv').config();
const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// 1) Importa o SDK oficial da OpenAI
const { Configuration, OpenAIApi } = require('openai');

// 2) Configura com sua API Key
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY, // Defina no Render.com ou .env
});
const openai = new OpenAIApi(configuration);

const app = express();
const PORT = process.env.PORT || 3000;

// Armazenamento simples em memória
let docsTexts = {};          // { nomeArquivo: textoExtraido, ... }
let conversationHistory = []; // [{ user: 'User'/'Bot', message: '...' }, ...]

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
    // Concatena todo o texto (BEM simples; não recomendado para arquivos grandes)
    const allDocsText = Object.values(docsTexts).join('\n\n---\n\n');

    // Construímos um prompt que inclua:
    // - Dados dos arquivos
    // - Histórico de conversa
    // - Pergunta do usuário
    const prompt = `
CONTEXT (from uploaded files):
${allDocsText}

CHAT HISTORY:
${conversationHistory.map((c) => `${c.user}: ${c.message}`).join('\n')}

USER: ${message}
BOT:
`;

    // 3) Chama a API do OpenAI com o modelo 'o1'
    const response = await openai.createCompletion({
      model: 'o1',             // conforme docs
      prompt: prompt,
      max_tokens: 200,
      temperature: 0.7,
    });

    // Pega a resposta do modelo
    const botReply = response.data?.choices?.[0]?.text?.trim() 
                  || 'Desculpe, não foi possível obter resposta.';

    // Atualiza histórico
    conversationHistory.push({ user: 'User', message });
    conversationHistory.push({ user: 'Bot', message: botReply });

    return res.json({ reply: botReply });
  } catch (error) {
    console.error('Error in chatbot:', error?.response?.data || error.message);
    return res.status(500).json({ error: 'Error processing the message' });
  }
});

// Endpoint para upload de arquivos
app.post('/upload', async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  const file = req.files.file;
  const uploadDir = path.join(__dirname, 'uploads');

  // Cria pasta se não existir
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const uploadPath = path.join(uploadDir, file.name);

  // Salvar fisicamente o arquivo
  file.mv(uploadPath, async (err) => {
    if (err) {
      console.error('File upload error:', err);
      return res.status(500).send(err);
    }

    // Tentar extrair texto do arquivo
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
        // Tenta ler como texto simples
        extractedText = fs.readFileSync(uploadPath, 'utf8');
      }
    } catch (parseError) {
      console.error('Error extracting text:', parseError);
      extractedText = '';
    }

    // Salva texto na memória, indexado pelo nome do arquivo
    docsTexts[file.name] = extractedText;

    return res.json({
      message: 'File uploaded and parsed successfully',
      fileName: file.name
    });
  });
});

// Endpoint para listar arquivos
app.get('/files', (req, res) => {
  const list = Object.keys(docsTexts).map((fileName) => ({ name: fileName }));
  res.json(list);
});

// Serve o index.html (UI)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Sobe servidor
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
