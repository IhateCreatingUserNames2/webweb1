// realtime.js

// Função para inicializar a conexão Realtime com a API da OpenAI
async function initRealtime() {
  try {
    // 1. Obter um token efêmero do servidor
    const tokenResponse = await fetch('/session');
    const tokenData = await tokenResponse.json();
    const EPHEMERAL_KEY = tokenData.client_secret && tokenData.client_secret.value 
      ? tokenData.client_secret.value 
      : null;
    if (!EPHEMERAL_KEY) {
      throw new Error("Token efêmero não encontrado na resposta do /session");
    }
    console.log("Token efêmero obtido:", EPHEMERAL_KEY);

    // 2. Criar uma RTCPeerConnection
    const pc = new RTCPeerConnection();

    // 3. Configurar o elemento de áudio para reproduzir o áudio remoto
    let audioEl = document.getElementById("remote-audio");
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = "remote-audio";
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
    }
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      console.log("Recebido stream remoto:", remoteStream);
      audioEl.srcObject = remoteStream;
    };

    // 4. Adicionar a track de áudio local (captura do microfone)
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
      console.log("Track de áudio local adicionada.");
    } catch (microphoneError) {
      console.error("Erro ao acessar o microfone:", microphoneError);
      return;
    }

    // 5. Configurar o canal de dados para envio e recebimento de eventos
    const dc = pc.createDataChannel("oai-events");
    window.oaiDataChannel = dc; // Expor globalmente
    dc.addEventListener("message", (e) => {
      const realtimeEvent = JSON.parse(e.data);
      console.log("Evento recebido do servidor Realtime:", realtimeEvent);
      // Atualize a interface do chatbot conforme necessário
    });

    // 6. Criar a oferta SDP e configurar a descrição local
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log("SDP offer criada e configurada localmente.");

    // 7. Enviar a oferta SDP para a API Realtime da OpenAI
    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp"
      }
    });

    // 8. Receber a resposta SDP do servidor e configurar a descrição remota
    const answerSdp = await sdpResponse.text();
    const answer = { type: "answer", sdp: answerSdp };
    await pc.setRemoteDescription(answer);
    console.log("Conexão Realtime estabelecida com sucesso.");

    // 9. Exemplo: Enviar um evento pelo canal de dados após 5 segundos
    function sendRealtimeEvent() {
      const eventData = {
        type: "response.create",
        response: {
          modalities: ["text"],
          instructions: "Hello from realtime client!",
        },
      };
      dc.send(JSON.stringify(eventData));
      console.log("Evento enviado via data channel:", eventData);
    }
    setTimeout(sendRealtimeEvent, 5000);

    // Monitorar alterações no estado da conexão ICE para depuração
    pc.oniceconnectionstatechange = () => {
      console.log("Estado da conexão ICE:", pc.iceConnectionState);
    };

  } catch (error) {
    console.error("Erro ao inicializar o Realtime:", error);
  }
}

// Inicializa a conexão quando a página carregar
window.addEventListener('load', initRealtime);
