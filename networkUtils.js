const stream = require('stream-browserify');
const Buffer = require('buffer').Buffer;
const gzip = require('gzip-js');
const WebTorrent = require('webtorrent');

// adapter
if (typeof window === 'undefined') {
  window = global;
}
if (!window.RTCPeerConnection) {
  window.RTCPeerConnection = window.webkitRTCPeerConnection || window.mozRTCPeerConnection || null;
}

const api = {};

const serveTorrent = (opts, cb) => {
  const {name, data} = opts;

  const client = new WebTorrent();
  client.seed(data, {
    name,
  }, torrent => {
    const {magnetURI} = torrent;
    cb(magnetURI);
  });

  const _close = () => {
    client.destroy();
  };

  return _close;
};
api.serveTorrent = serveTorrent;

const downloadTorrent = (uri, cb) => {
  const client = new WebTorrent();

  client.add(uri, torrent => {
    const {files} = torrent;
    const file = files[0];

    _readFile(file, data => {
      const {name} = file;

      client.destroy();

      cb({
        name,
        data,
      });
    });
  });
};
api.downloadTorrent = downloadTorrent;

const _readFile = (file, cb) => {
  const bs = [];
  const rs = file.createReadStream();
  rs.on('data', b => {
    bs.push(b);
  });
  rs.on('end', () => {
    const data = Buffer.concat(bs);
    cb(data);
  });
};

// XXX
const testTorrent = () => {
  const srcFile = {
    name: 'lol.txt',
    data: new Buffer('lol', 'utf8'),
  };
  const close = serveTorrent(srcFile, uri => {
    console.log('created torrent', uri);

    downloadTorrent(uri, dstFile => {
      console.log('got torrent result', dstFile);

      close();
    });
  });
};
api.testTorrent = testTorrent;

const cfg = {'iceServers': [{'url': 'stun:23.21.150.121'}]};
const con = { 'optional': [{'DtlsSrtpKeyAgreement': true}] };
const sdpConstraints = {
  /* optional: [],
  mandatory: {
    OfferToReceiveAudio: true,
    OfferToReceiveVideo: true
  }, */
};
const getRtcInviteStream = cb => {
  // initialize
  const pc1 = new RTCPeerConnection(cfg, con);
  const localStream = new stream.PassThrough();
  const remoteStream = new stream.PassThrough();
  pc1.onicecandidate = e => {
    if (e.candidate == null) {
      pc1.onicecandidate = null;

      const inviteString = JSON.stringify(pc1.localDescription);
      const invite = _lineify(_zip(inviteString));
      const inviteStream = new stream.Duplex();
      inviteStream.pc1 = pc1;
      inviteStream.invite = invite;
      inviteStream._read = size => {};
      inviteStream._write = (chunk, encoding, cb) => {
        // console.log('invite write', {chunk, encoding});

        localStream.write(chunk, encoding, cb);
      };
      inviteStream.on('finish', () => {
        localStream.end();
      });
      remoteStream.on('data', data => {
        inviteStream.push(data);
      });
      remoteStream.on('end', () => {
        inviteStream.push(null);
      });
      cb(inviteStream);
    }
  };

  // create local offer
  const dc1 = pc1.createDataChannel('test', {reliable: true});
  dc1.onopen = () => {
    // console.log('data channel connect 1');

    localStream.on('data', message => {
      const data = message.toString('base64');
      dc1.send(data);
    });
    localStream.on('end', () => {
      dc1.close();
      pc1.close();
    });
  };
  dc1.onclose = () => {
    remoteStream.end();
  };
  dc1.onmessage = e => {
    // console.log('Got message (pc1)', e.data);
    if (e.data.charCodeAt(0) == 2) {
      // The first message we get from Firefox (but not Chrome)
      // is literal ASCII 2 and I don't understand why -- if we
      // leave it in, JSON.parse() will barf.
      return;
    }
    var {data} = e;
    const message = new Buffer(data, 'base64');
    remoteStream.write(message);
  };
  pc1.createOffer(
    desc => {
      pc1.setLocalDescription(desc, () => {}, () => {});
    },
    () => {
      console.warn("Couldn't create offer");
    },
    sdpConstraints
  );
};
api.getRtcInviteStream = getRtcInviteStream;

const getRtcAnswerStream = (invite, cb) => {
  const inviteString = _unzip(_unlineify(invite));
  const inviteDescription = JSON.parse(inviteString);

  // initialize
  const pc2 = new RTCPeerConnection(cfg, con);
  const localStream = new stream.PassThrough();
  const remoteStream = new stream.PassThrough();
  pc2.onicecandidate = e => {
    if (e.candidate == null) {
      const answerString = JSON.stringify(pc2.localDescription);
      const answer = _lineify(_zip(answerString));
      const answerStream = new stream.Duplex();
      answerStream.pc2 = pc2;
      answerStream.answer = answer;
      answerStream._read = size => {};
      answerStream._write = (chunk, encoding, cb) => {
        // console.log('answer write', {chunk, encoding});

        localStream.write(chunk, encoding, cb);
      };
      answerStream.on('finish', () => {
        localStream.end();
      });
      remoteStream.on('data', data => {
        answerStream.push(data);
      });
      remoteStream.on('end', () => {
        answerStream.push(null);
      });
      cb(answerStream);
    }
  };
  pc2.ondatachannel = e => {
    const dc2 = e.channel || e; // Chrome sends event, FF sends raw channel
    dc2.onopen = e => {
      // console.log('data channel connect 2');

      localStream.on('data', message => {
        const data = message.toString('base64');
        dc2.send(data);
      });
      localStream.on('end', () => {
        dc2.close();
        pc2.close();
      });
    };
    dc2.onclose = () => {
      remoteStream.end();
    };
    dc2.onmessage = e => {
      // console.log('Got message (pc2)', e.data)
      const {data} = e;
      const message = new Buffer(data, 'base64');
      remoteStream.write(message);
    };
  };

  // create answer
  pc2.setRemoteDescription(inviteDescription);
  pc2.createAnswer(
    answerDesc => {
      pc2.setLocalDescription(answerDesc);
    },
    () => {
      console.warn("Couldn't create offer");
    },
    sdpConstraints
  );
};
api.getRtcAnswerStream = getRtcAnswerStream;

const ackRtcAnswer = (inviteStream, answer, cb) => {
  const answerString = _unzip(_unlineify(answer));
  const answerDescription = JSON.parse(answerString);

  const {pc1} = inviteStream;
  pc1.setRemoteDescription(answerDescription);
};

const _zip = s => {
  const zippedArray = gzip.zip(s);
  const buffer = new Buffer(zippedArray);
  const d = buffer.toString('base64');
  return d;
};

const _unzip = d => {
  const buffer = new Buffer(d, 'base64');
  const zippedArray = buffer.toJSON().data;
  const unzippedArray = gzip.unzip(zippedArray);
  const s = new Buffer(unzippedArray).toString('utf8');
  return s;
};

const _lineify = s => s.replace(/(.{80})/g, '$1\n');

const _unlineify = s => s.replace(/\n/g, '');

// XXX
const testRtc = () => {
  getRtcInviteStream(inviteStream => {
    const {invite} = inviteStream;
    // console.log('got invite', invite);

    getRtcAnswerStream(invite, answerStream => {
      const {answer} = answerStream;
      // console.log('got answer', answer);

      ackRtcAnswer(inviteStream, answer);

      inviteStream.write('request');
      inviteStream.setEncoding('utf8');
      inviteStream.on('data', s => {
        console.log('invite got:', JSON.stringify(s));

        inviteStream.end();
      });
      inviteStream.on('end', () => {
        console.log('invite end');
      });
      answerStream.setEncoding('utf8');
      answerStream.on('data', s => {
        console.log('answer got:', JSON.stringify(s));

        answerStream.write('response');
      });
      answerStream.on('end', () => {
        console.log('answer end');
      });
    });
  });
};
api.testRtc = testRtc;

module.exports = api;
