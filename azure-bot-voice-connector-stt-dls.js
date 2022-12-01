'use strict'

//-------------

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const expressWs = require('express-ws')(app);
const WebSocketClient = require('websocket').client;

// -- HTTP client --

const webHookRequest = require('request');

const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
};

//--------------------

app.use(bodyParser.json());

//-------

const router = express.Router();

router.get('/', express.static('app'));
app.use('/app',router);

//----- Microsoft Azure cognitive services speech SDK

const msaSpeechSdk = require("microsoft-cognitiveservices-speech-sdk");

const samplingRate = 16000; // Hz
const sampleSize = 16; // bits
const channels = 1; // number of audio channels in stream

const msaSpeechServiceKey = process.env.MSA_SPEECH_SERVICE_KEY;
const msaRegion = process.env.MSA_REGION;
const msaBotName = process.env.MSA_BOT_NAME;

//==========================================================

function reqCallback(error, response, body) {
    if (body != "Ok") {  
      console.log("Webhook call status to VAPI application:", body);
    };  
}
  
//-----------

async function returnReply(request, reply, languageCode, uuid, webhookUrl, customParams) {

  const result = {
    'vapiUuid': uuid,
    'request': request,
    'reply': reply,
    'languageCode': languageCode
  };

  // return custom properties
  const cParameters = JSON.parse(customParams);
  // console.log('cParameters:', cParameters);

  for (let key in cParameters) {
    if (cParameters.hasOwnProperty(key)) {
        // console.log(key + " -> " + cParameters[key]);
        result[key] =  cParameters[key];
    }
  }     

  console.log("result:", JSON.stringify(result));

  const reqOptions = {
    url: webhookUrl,
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(result)
  };

  webHookRequest(reqOptions, reqCallback);

}

//----------------->>>>>

app.ws('/socket', async (ws, req) => {

  const originalUuid = req.query.original_uuid; 

  console.log('>>> websocket connected with');
  console.log('original call uuid:', originalUuid);

  const webhookUrl = req.query.webhook_url;

  console.log('>>> webhookUrl:', webhookUrl);

  let xCustomFields = [];
  let customQueryParams = '';

  for (const queryParameter in req.query){    
    if (`${queryParameter}`.substring(0, 2) == 'x_') {
      xCustomFields.push(`"${queryParameter}": "${req.query[`${queryParameter}`]}"`);
    }
  };

  customQueryParams = "{" + xCustomFields.join(", ") + "}";
  console.log('>>> websocket custom query parameters:', customQueryParams);

  const languageCode = req.query.language_code;
  console.log('>>> languageCode:', languageCode);

  let latestTranscript = "";

  //--- Azure STT and Bot Framework setup ---

  const msaAudioInputStream = msaSpeechSdk.AudioInputStream.createPushStream(msaSpeechSdk.AudioStreamFormat.getWaveFormatPCM(samplingRate, sampleSize, channels))
  const msaAudioConfig = msaSpeechSdk.AudioConfig.fromStreamInput(msaAudioInputStream);

  //--- Azure STT setup ---

  const msaSpeechConfig = msaSpeechSdk.SpeechConfig.fromSubscription(msaSpeechServiceKey, msaRegion);
  msaSpeechConfig.speechRecognitionLanguage = languageCode;
  msaSpeechConfig.enableDictation();

  const msaSpeechRecognizer = new msaSpeechSdk.SpeechRecognizer(msaSpeechConfig, msaAudioConfig);

  //--- Bot Framework setup ---

  const msaBotConfig = msaSpeechSdk.BotFrameworkConfig.fromSubscription(msaSpeechServiceKey, msaRegion, msaBotName);
  msaBotConfig.speechRecognitionLanguage = languageCode;

  const msaConnector = new msaSpeechSdk.DialogServiceConnector(msaBotConfig, msaAudioConfig);

  //--- TTS play to client over WebSocket ---

  async function playAudio(audioPayload) {

    // TO DO: add flag and wait timers to prevent simultaneous playbacks

    // const audioPayload = new Uint8Array(payload).slice(0);
    
    try {
      
      const timerIds = app.get(`playtimers_${originalUuid}`) || [];
      
      for (const timerId of timerIds) {
        clearTimeout(timerId);
      };

      console.log(">>> audio payload length:", audioPayload.length);

      if ( audioPayload.length > 0 ) {

        console.log(">>> Playback in progress for websocket associated to original uuid:", originalUuid);
        
        // Sending Bot audio response to caller via websocket
        
        const frames = audioPayload.length / 640;
        // console.log({frames});
        let pos = 0;
        const timerIds = [];
        
        for (let i = 0; i < frames + 1; i++) {
          const newpos = pos + 640;
          const data = audioPayload.slice(pos, newpos);
          
          timerIds.push(setTimeout(function () {
            if (ws.readyState === 1) {  // Send data only if websocket is up
              ws.send(data);
            }
          }, i * 20))  // Send a frame every 20 ms
          
          pos = newpos;

        }

        app.set(`playtimers_${originalUuid}`, timerIds);

      }
    } catch (e) {
      
      console.log("WebSocket error:", e);
    
    }

  }  

  //--- Azure TTS setup ---

  const msaTtsSpeechConfig = msaSpeechSdk.SpeechConfig.fromSubscription(msaSpeechServiceKey, msaRegion);
  msaTtsSpeechConfig.speechSynthesisLanguage = languageCode;
  msaTtsSpeechConfig.speechSynthesisOutputFormat = 'Raw16Khz16BitMonoPcm';
  msaTtsSpeechConfig.speechSynthesisVoiceName = 'en-US-JennyNeural'; // temporary hard coding - TBD: to be set by the bot reply

  // class PushAudioOutputStreamToClientCallback extends msaSpeechSdk.PushAudioOutputStreamCallback {
  //   constructor(cb) {
  //       super();
  //       this.buffer;
  //       this.length = 0;
  //       this.isClosed = false;
  //       this.cb = cb;
  //   }

  //   write(dataBuffer) {
  //     try {
  //       // console.log("writing to buffer...")
  //       if (this.isClosed) {
  //         console.log("you can't write while the buffer is closed");
  //         throw new InvalidOperationError("PushAudioOutputStreamCallback already closed");
  //       }
  //       if (!this.buffer) {
  //         this.buffer = new Uint8Array(dataBuffer);
  //       } else {
  //         const temp = new Uint8Array(this.length + dataBuffer.byteLength);
  //         // console.log({buflen: this.length, data: dataBuffer});
  //         temp.set(this.buffer, 0);
  //         temp.set(dataBuffer, this.length);
  //         // console.log(buf2hex(dataBuffer));
  //         this.buffer = temp;
  //       }
  //       this.length += dataBuffer.byteLength;
  //       // console.log("wrote to buffer:");
  //       // console.log(this.length);
  //       // console.log(dataBuffer);
  //     } catch(e) {
  //       console.log("failed to write");
  //       console.log(e);
  //     }
      
  //   }

  //   close() {
  //       if (this.isClosed) {
  //           throw new InvalidOperationError("PushAudioOutputStreamCallback already closed");
  //       }
  //       this.isClosed = true;
  //       console.log("completed buffer:");
  //       // console.log(buf2hex(this.buffer));
  //       b1 = new Uint8Array(this.buffer);
  //       this.cb(this, this.buffer, this.length);
  //       console.log("the buffer was closed");
  //   }

  //   // clearBuffer() {
  //   //   this.buffer = undefined;
  //   //   this.length = 0;
  //   //   console.log("the buffer was cleared");
  //   // }
  // }

  //---

  // const replyAudioCallback = async (pushAudio, buffer, length) => {
  //   console.log(`the full buffer is ${length} bytes long`);
  //   // console.log(`the full buffer is ${length} bytes long, here it is:`);
  //   // console.log(buffer);
  //   // pushAudio.clearBuffer();

  //   // send buffer payload over Vonage WebSocket to the client
  //   await playAudio(buffer);

  // };

  const msaSpeechSynthesizer = new msaSpeechSdk.SpeechSynthesizer(msaTtsSpeechConfig);

  //--- Azure Bot Framework operation ---

  msaConnector.activityReceived = (sender, event) => {
    
    console.log("\n>>>>> Activity received >>>>>");

    // console.log(JSON.stringify(event));

    const botReply = event.privActivity.text;
    console.log('Bot reply:', botReply);

    returnReply(latestTranscript, botReply, languageCode, originalUuid, webhookUrl, customQueryParams) ;

    msaSpeechSynthesizer.speakTextAsync(botReply, (result) => {
      if (result.reason === msaSpeechSdk.ResultReason.SynthesizingAudioCompleted) {
        console.log({result});
        playAudio(new Uint8Array(result.privAudioData));
      } else {
        console.log("speech synth ended with an error reason");
      }
    }, (e) => {
        console.error(e);
    });

  };

  msaConnector.recognizing = (sender, event) => {
    console.log(`Intermediate transcript: ${event.result.text}`);
  };

  msaConnector.recognized = (sender, event) => {
    if (event.result.reason == msaSpeechSdk.ResultReason.RecognizedSpeech) {

      console.log("\nRecognized - Result:");
      console.log(event);

    }
    else if (event.result.reason == msaSpeechSdk.ResultReason.NoMatch) {
      
      console.log("\nNo speech detected");
    
    }
  };

  msaConnector.canceled = (sender, event) => {

    console.log('Connector error:');
    console.log(JSON.stringify(event));

    // msaConnector.disconnect();
  };

  msaConnector.turnStatusReceived = (sender, event) => {
    console.log("\nTurn status received:");
    console.log(JSON.stringify(event));
  };

  msaConnector.speechStartDetected = (sender, event) => {
    console.log("\nSpeech start detected:");
    console.log(JSON.stringify(event));
  };

  msaConnector.speechStopDetected = (sender, event) => {
    console.log("\nSpeech stop detected:");
    console.log(JSON.stringify(event));
  };

  msaConnector.sessionStarted = (sender, event) => {
    console.log("\nConnector session started:");
    console.log(JSON.stringify(event));
  };

  msaConnector.sessionStopped = (sender, event) => {
    console.log("\nConnector session stopped:");
    console.log(JSON.stringify(event));

    msaConnector.disconnect();
  };

  //--- Azure STT operation ---

  // msaSpeechRecognizer.recognizing = (s, e) => {
  //   console.log(`Intermediate transcript: ${e.result.text}`);
  // };

  msaSpeechRecognizer.recognized = (s, e) => {
    if (e.result.reason == msaSpeechSdk.ResultReason.RecognizedSpeech) {
      
      const transcript = e.result.text;
      console.log("Final transcript:", transcript);

      if (transcript != '') {

        latestTranscript = transcript;
        
        const inputActivity = `{ "type": "message", "text": "${transcript}" }`;

        console.log('inputActivity:', inputActivity);

        sendRequestToBot(inputActivity);
      
      } else {
        
        console.log("Empty transcript!")
      
      }

    }
    else if (e.result.reason == msaSpeechSdk.ResultReason.NoMatch) {
      
      console.log("No speech detected");
    
    }
  };

  msaSpeechRecognizer.canceled = (s, e) => {
    console.log(`Error: ${e.reason}`);

    if (e.reason == msaSpeechSdk.CancellationReason.Error) {
        console.log(`Error code=${e.errorCode}`);
        console.log(`Error message=${e.errorDetails}`);
    }

    msaSpeechRecognizer.stopContinuousRecognitionAsync();
  };

  msaSpeechRecognizer.sessionStopped = (s, e) => {
    console.log("\nAzure STT stopped");
    msaSpeechRecognizer.stopContinuousRecognitionAsync();
  };

  //-- Start connector to Bot Framework

  await msaConnector.connect( () => {
    console.log("Azure Bot connection started ...");
  },
    err => {
        console.log("Error - msaConnector:", msaConnector);
        console.log("Error:", err);
  });

  //-- Start Speech to Text

  await msaSpeechRecognizer.startContinuousRecognitionAsync(() => {
    console.log("Azure STT started ...");
  },
    err => {
        console.log("Error:", err);
        msaSpeechRecognizer.close();
        msaSpeechRecognizer = undefined;
    });

  //-- Module level function to send requests to Bot

  async function sendRequestToBot(request) {

    msaConnector.sendActivityAsync( request, () => {
      console.log("Send request to bot ...");
    },
    err => {
      console.log("Send request to bot error:", err);
    });  
  
  }
  
  //--------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log("\n>>> Websocket settings:", msg);
    
    } else {

      msaAudioInputStream.write(msg); // stream audio chunk to Azure STT

    }   

  });

  //--

  ws.on('close', async () => {

    msaAudioInputStream.close();
    
    // msaAudioConfig.close(); // error this.privSource.turnOff().then(function () {TypeError: Cannot read properties of undefined (reading 'then') ...
    msaConnector.close();
    msaBotConfig.close();

    msaSpeechRecognizer.stopContinuousRecognitionAsync();

    msaSpeechSynthesizer.close();

    console.log("WebSocket closed");
    
  });

});

//------------------ for Neru ----------------------

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

//==================================================

const port = process.env.NERU_APP_PORT || process.env.PORT || 6000;

app.listen(port, () => console.log(`Azure Bot Framework - Voice connector server running on port ${port}.`));

//------------
