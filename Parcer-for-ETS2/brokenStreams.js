// Known-broken stream data and the matcher used to skip them during scraping.
// Extracted from app.js verbatim so the main file stays under the file-length
// limit. Behavior is identical to the original inline definitions.

// List of known broken streams
const KNOWN_BROKEN_STREAMS = [
    "http://176.102.194.71:44808/radio",
    "http://185.96.188.24:8000/live",
    "http://78.154.164.191:18001/4",
    "http://91.203.4.121:8000/stream160",
    "http://complex.in.ua:80/struy",
    "http://online.sokal.lviv.ua:8000/sokalfm96.mp3",
    "http://stream-154.zeno.fm/ilibzonk6hotv",
    "https://audio.x-on.com.ua:8443/x-on-mp3-320.mp3",
    "https://bestfm.fm/",
    "https://c2.radioboss.fm:18472/stream",
    "https://cdn-br2.live-tv.cloud/sferarvFM/64k/icecast.audio",
    "https://cdn.vsnw.net:8943/kyiv_fm_128k",
    "https://complex.in.ua/b128",
    "https://complex.in.ua/buskfm",
    "https://complex.in.ua/tvoeRadio",
    "https://complex.in.ua/yantarne",
    "https://complex.in.ua/Yavir",
    "https://complex.in.ua/zhudachiv",
    "https://ec5.yesstreaming.net:2225/stream",
    "https://globalic.stream:1155/stream",
    "https://globalic.stream:1440/stream",
    "https://globalic.stream:1535/stream",
    "https://globalic.stream:1575/stream",
    "https://greeksonic.alphaserver.gr/8010/stream",
    "https://icecast.xtvmedia.pp.ua/melodeon.mp3",
    "https://icecast.xtvmedia.pp.ua/radiowandafm_hq.mp3",
    "https://icecast.xtvmedia.pp.ua/UKRNR.mp3",
    "https://listen6.myradio24.com/82192",
    "https://live.1tv.od.ua/radio/stream/icecast.audio",
    "https://main.inf.fm:8101/;",
    "https://myradio24.org/46801;stream.nsv",
    "https://onair.lviv.fm:8443/lviv.fm",
    "https://online-radio.nv.ua/radionv.mp3",
    "https://online.radiorecord.com.ua/rr_320",
    "https://play.radiotakt.com.ua/",
    "https://pulzusfm.eu/sionelo",
    "https://radio.bestfm.ua/bestfm",
    "https://radio.bug.fm:8000/radioBug",
    "https://radio.c4.com.ua:8443/320",
    "https://radio.dzvony.org.ua/",
    "https://radio.groza.ua:8443/neoradio",
    "https://radio.mfm.ua/online128",
    "https://radio.perec.fm/radio-stilnoe",
    "https://radio.radioshansonplus.com:8005/radio",
    "https://radio.radioshansonplus.com:8055/radio",
    "https://radio.rai.ua:9000/rai",
    "https://radio.ukr.radio/ur3-mp3-m",
    "https://radio.ukr.radio/ur5-mp3",
    "https://radio.zfm.com.ua:8443/zfm",
    "https://radiofm.stream:8443/muzvar_sq",
    "https://radiolla.com/",
    "https://radiostream.nakypilo.ua/full",
    "https://rockradioua.online:8433/rock_dodatok_256",
    "https://s5.radioforge.com:7908/live",
    "https://s61.radiolize.com/radio/8000/radio.mp3",
    "https://stream-153.zeno.fm/nkeaps48xg0uv",
    "https://stream-157.zeno.fm/m7tw0rc5kuhvv",
    "https://stream-159.zeno.fm/5ez2dnpgixktv",
    "https://stream-159.zeno.fm/swzfd3a9dchvv",
    "https://stream.blits-fm.ua/stream320",
    "https://stream.chv.ua:8443/acc.mp3",
    "https://stream.mistofm.com/listen/misto_fm_deep/radio.mp3",
    "https://stream.mistonadbugom.com.ua:8006/radiomistonadbugom",
    "https://stream.mjoy.ua:8443/kredens-cafe-radio_mp3",
    "https://stream.mjoy.ua:8443/radio-egoisty",
    "https://stream.mjoy.ua:8443/radio-great",
    "https://stream.mjoy.ua:8443/radio-mousse",
    "https://stream.radio.co/s4360dbc20/listen",
    "https://stream.radio.silpo.ua/silpo",
    "https://stream4.nadaje.com:9889/lux64",
];

// URL patterns for partial matching (for zeno.fm with tokens)
const BROKEN_URL_PATTERNS = [
    "stream-154.zeno.fm/ilibzonk6hotv",
    "stream-153.zeno.fm/nkeaps48xg0uv",
    "stream-157.zeno.fm/m7tw0rc5kuhvv",
    "stream-159.zeno.fm/5ez2dnpgixktv",
    "stream-159.zeno.fm/swzfd3a9dchvv",
];

// Check if URL is a known broken stream
const isKnownBrokenStream = (url) => {
    if (KNOWN_BROKEN_STREAMS.includes(url)) {
        return true;
    }

    for (const pattern of BROKEN_URL_PATTERNS) {
        if (url.includes(pattern)) {
            return true;
        }
    }

    return false;
};

export {
    KNOWN_BROKEN_STREAMS,
    BROKEN_URL_PATTERNS,
    isKnownBrokenStream,
};
