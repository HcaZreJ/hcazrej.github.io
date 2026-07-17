(function () {
  'use strict';

  function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return '--:--';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- 页尾 tab（浏览器环境专属，Node 下（如测试）整体跳过） ----
  if (typeof document !== 'undefined') {
    // ---- 页尾 tab（按 .panel DOM 顺序自动生成） ----
    var more = document.querySelector('.more');
    if (more) {
      more.classList.add('js');

      var tabsNav = more.querySelector('.tabs');
      var panels = more.querySelectorAll('.panel');

      if (tabsNav) {
        panels.forEach(function (panel, index) {
          var titleEl = panel.querySelector('.panel-title');
          var name = panel.dataset.panel;
          var tab = document.createElement('button');
          tab.className = 'tab';
          tab.dataset.tab = name;
          tab.textContent = titleEl ? titleEl.textContent : name;
          if (index === 0) {
            tab.classList.add('is-active');
            panel.classList.add('is-active');
          }
          tabsNav.appendChild(tab);
        });
      }

      var tabs = more.querySelectorAll('.tab');

      var activateTab = function (name) {
        tabs.forEach(function (tab) {
          tab.classList.toggle('is-active', tab.dataset.tab === name);
        });
        panels.forEach(function (panel) {
          panel.classList.toggle('is-active', panel.dataset.panel === name);
        });
      };

      tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
          activateTab(tab.dataset.tab);
        });
      });
    }
  }

  // ---- ID3v2 标签解析（无第三方库；纯函数，浏览器/Node 通用） ----
  function syncsafeInt(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
  }

  function decodeUtf16Swapped(bytes) {
    var swapped = new Uint8Array(bytes.length);
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }

  function decodeId3Text(bytes, encoding) {
    if (encoding === 1) {
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      }
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return decodeUtf16Swapped(bytes.subarray(2));
      }
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (encoding === 2) return decodeUtf16Swapped(bytes);
    if (encoding === 3) return new TextDecoder('utf-8').decode(bytes);
    return new TextDecoder('windows-1252').decode(bytes);
  }

  function parseTextFrame(data) {
    if (data.length < 1) return '';
    var encoding = data[0];
    var text = decodeId3Text(data.subarray(1), encoding);
    return text.replace(/[\s\u0000]+$/, '');
  }

  function parseApicFrame(data) {
    if (data.length < 2) return null;
    var encoding = data[0];
    var pos = 1;
    var mimeEnd = pos;
    while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
    if (mimeEnd >= data.length) return null;
    var mime = new TextDecoder('windows-1252').decode(data.subarray(pos, mimeEnd));
    pos = mimeEnd + 1;
    if (pos >= data.length) return null;
    pos += 1; // picture type byte
    var descEnd = pos;
    if (encoding === 1 || encoding === 2) {
      while (descEnd + 1 < data.length && !(data[descEnd] === 0 && data[descEnd + 1] === 0)) descEnd += 2;
      pos = descEnd + 2;
    } else {
      while (descEnd < data.length && data[descEnd] !== 0) descEnd++;
      pos = descEnd + 1;
    }
    if (pos >= data.length || !mime) return null;
    var imageBytes = data.subarray(pos);
    if (imageBytes.length === 0) return null;
    var blob = new Blob([imageBytes], { type: mime });
    return URL.createObjectURL(blob);
  }

  function parseId3Frames(buf, start, end, majorVersion) {
    var result = {};
    var pos = start;
    while (pos + 10 <= end) {
      if (buf[pos] === 0) break;
      var id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      var size;
      if (majorVersion >= 4) {
        size = syncsafeInt(buf, pos + 4);
      } else {
        size = ((buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7]) >>> 0;
      }
      var dataStart = pos + 10;
      var dataEnd = dataStart + size;
      if (size <= 0 || dataEnd > end) break;
      var frameData = buf.subarray(dataStart, dataEnd);
      if (id === 'TIT2') result.title = parseTextFrame(frameData);
      else if (id === 'TPE1') result.artist = parseTextFrame(frameData);
      else if (id === 'TALB') result.album = parseTextFrame(frameData);
      else if (id === 'APIC') result.picture = parseApicFrame(frameData);
      pos = dataEnd;
    }
    return result;
  }

  function fetchRange(url, start, end) {
    return fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    });
  }

  function readId3(url) {
    return fetchRange(url, 0, 9).then(function (buf) {
      var headBuf = new Uint8Array(buf);
      if (headBuf.length < 10) return null;
      if (headBuf[0] !== 0x49 || headBuf[1] !== 0x44 || headBuf[2] !== 0x33) return null;
      var flags = headBuf[5];
      if (flags & 0x80) return null; // unsynchronisation
      if (flags & 0x40) return null; // extended header
      var tagSize = syncsafeInt(headBuf, 6);
      var totalNeeded = 10 + tagSize;
      var majorVersion = headBuf[3];

      if (headBuf.length >= totalNeeded) {
        return parseId3Frames(headBuf, 10, totalNeeded, majorVersion);
      }
      return fetchRange(url, 0, totalNeeded - 1).then(function (fullBuf) {
        var buf2 = new Uint8Array(fullBuf);
        if (buf2.length < 10) return null;
        return parseId3Frames(buf2, 10, Math.min(totalNeeded, buf2.length), majorVersion);
      });
    }).catch(function (err) {
      console.warn('[music] ID3 解析失败', url, err);
      return null;
    });
  }

  // ---- 自托管播放器（浏览器环境专属） ----
  if (typeof document !== 'undefined') {
  var tracks = document.querySelectorAll('.track');
  var audios = [];
  tracks.forEach(function (track) {
    var audio = track.querySelector('audio');
    if (audio) audios.push(audio);
  });

  var userHasPlayed = false;

  tracks.forEach(function (track) {
    var audio = track.querySelector('audio');
    var playBtn = track.querySelector('.track-play');
    var bar = track.querySelector('.track-bar');
    var fill = track.querySelector('.track-fill');
    var timeEl = track.querySelector('.track-time');
    var coverEl = track.querySelector('.track-cover');
    var nameEl = track.querySelector('.track-name');
    var artistEl = track.querySelector('.track-artist');
    if (!audio || !playBtn || !bar || !fill || !timeEl) return;

    var duration = '--:--';

    playBtn.addEventListener('click', function () {
      if (audio.paused) {
        userHasPlayed = true;
        audios.forEach(function (other) {
          if (other !== audio) other.pause();
        });
        audio.play().catch(function (e) { console.warn('[music] 播放失败', e); });
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', function () {
      playBtn.textContent = '❚❚';
    });

    audio.addEventListener('pause', function () {
      playBtn.textContent = '▶';
    });

    audio.addEventListener('loadedmetadata', function () {
      duration = formatTime(audio.duration);
      timeEl.textContent = formatTime(audio.currentTime) + ' / ' + duration;
    });

    audio.addEventListener('timeupdate', function () {
      if (audio.duration) {
        fill.style.width = (audio.currentTime / audio.duration * 100) + '%';
      }
      timeEl.textContent = formatTime(audio.currentTime) + ' / ' + duration;
    });

    bar.addEventListener('click', function (event) {
      var rect = bar.getBoundingClientRect();
      var ratio = (event.clientX - rect.left) / rect.width;
      if (audio.duration) {
        audio.currentTime = ratio * audio.duration;
      }
    });

    audio.addEventListener('ended', function () {
      playBtn.textContent = '▶';
      fill.style.width = '0%';
      timeEl.textContent = '0:00 / ' + duration;
    });

    readId3(audio.currentSrc || audio.src).then(function (tags) {
      if (!tags) return;
      if (tags.title && nameEl) nameEl.textContent = tags.title;
      if (artistEl && (tags.artist || tags.album)) {
        var parts = [];
        if (tags.artist) parts.push(tags.artist);
        if (tags.album) parts.push(tags.album);
        artistEl.textContent = parts.join(' · ');
      }
      if (tags.picture && coverEl) coverEl.src = tags.picture;
    });
  });

  // ---- 进页自动播放第一首 ----
  if (audios.length > 0) {
    var first = audios[0];
    var playAttempt = first.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(function () {
        var tryFallbackPlay = function (event) {
          document.removeEventListener('pointerdown', tryFallbackPlay);
          document.removeEventListener('keydown', tryFallbackPlay);
          // 手势本身就是点播放键时让位给点击逻辑，避免播完即被暂停/切歌
          if (event && event.target && event.target.closest && event.target.closest('.track-play')) return;
          if (!userHasPlayed && first.paused) {
            audios.forEach(function (other) {
              if (other !== first) other.pause();
            });
            first.play();
          }
        };
        document.addEventListener('pointerdown', tryFallbackPlay);
        document.addEventListener('keydown', tryFallbackPlay);
      });
    }
  }
  } // end browser-only 播放器 guard

  // ---- 测试专用导出（Node 环境；浏览器中 module 未定义，整段跳过，零运行时影响） ----
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      formatTime: formatTime,
      syncsafeInt: syncsafeInt,
      decodeUtf16Swapped: decodeUtf16Swapped,
      decodeId3Text: decodeId3Text,
      parseTextFrame: parseTextFrame,
      parseApicFrame: parseApicFrame,
      parseId3Frames: parseId3Frames
    };
  }
})();
