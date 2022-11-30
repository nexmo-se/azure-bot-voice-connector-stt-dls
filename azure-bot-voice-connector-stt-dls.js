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

  //--- Azure Bot Framework operation ---

  msaConnector.activityReceived = (sender, event) => {
    // console.log(`Activity received - Event: ${event} - Has audio: ${event.hasaudio} - Activity: ${event.activity} - Sender: ${sender}`);
    
    console.log("\n>>>>> Activity received >>>>>");

    // console.log(JSON.stringify(event));

    const botReply = event.privActivity.text;
    console.log('Bot reply:', botReply);

    returnReply(latestTranscript, botReply, languageCode, originalUuid, webhookUrl, customQueryParams) ;
  };

  msaConnector.recognizing = (sender, event) => {
    console.log(`Intermediate transcript: ${event.result.text}`);
  };

  msaConnector.recognized = (sender, event) => {
    if (event.result.reason == msaSpeechSdk.ResultReason.RecognizedSpeech) {

      console.log("\nRecognized - Result:");
      console.log(event);

      // tests - temporarily commented out      
      // const transcript = event.result.text;
      // console.log("Final transcript:", transcript);

      // if (transcript != '') {
      //   sendTranscript(transcript, languageCode, originalUuid, webhookUrl, customQueryParams) ;
      // } else {
      //   console.log("Empty transcript!")
      // }


      //execute a new listen -- this will not work because the session stopped
      msaConnector.listenOnceAsync((event) => {
        console.log("\nAzure Bot listen once async #1 ...");
      },
        event => {
          console.log(JSON.stringify(event));
      });

    }
    else if (event.result.reason == msaSpeechSdk.ResultReason.NoMatch) {
      
      console.log("\nNo speech detected");

      //execute a new listen -- this will not work because the session stopped
      msaConnector.listenOnceAsync((event) => {
        console.log("\nAzure Bot listen once async #2 ...");
      },
        event => {
          console.log(JSON.stringify(event));
      });
    
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

  // commented out, too verbose
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

        // does not work        
        // await msaConnector.sendActivityAsync( (inputActivity) => {
        //   console.log("Send input activity ...");
        // },
        // err => {
        //   console.log("Send input activity error:", err);
        // });

        sendRequestToBot(inputActivity);

        // do webhook call elsewhere; request/reply info
        // sendTranscript(transcript, languageCode, originalUuid, webhookUrl, customQueryParams) ;
      
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

    console.log("WebSocket closed");
    
  });

});

//-------------------- for Neru --------

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

//==================================================

const port = process.env.NERU_APP_PORT || process.env.PORT || 6000;

app.listen(port, () => console.log(`Azure Speech-to-Text - connector server code running on port ${port}.`));

//------------
