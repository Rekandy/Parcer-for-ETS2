const xmldom = require('xmldom');
const { DOMParser } = xmldom;
const fs = require('fs');

async function fetchRadioInfo(url) {
    try {
        const response = await fetch(url);
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const stationElements = doc.getElementsByClassName('stations__station');
        const radioInfoList = [];
        for (let i = 0; i < stationElements.length; i++) {
            const buttons = stationElements[i].getElementsByTagName('button');
            let radioButton;
            for (let j = 0; j < buttons.length; j++) {
                if (buttons[j].getAttribute('class') === 'b-play station_play') {
                    radioButton = buttons[j];
                    break;
                }
            }
            if (radioButton) {
                const streamValue = radioButton.getAttribute('stream');
                let radioNameValue = radioButton.getAttribute('radioName');
                radioNameValue = radioNameValue.replace(/&#34;/g, '');
                radioNameValue = radioNameValue.replace(/&#39;/g, "'");
                const links = stationElements[i].getElementsByTagName('a');
                let genre;
                for (let j = 0; j < links.length; j++) {
                    if (links[j].getAttribute('href').includes('/ua/genre/')) {
                        genre = links[j].textContent.trim();
                        genre = genre.charAt(0).toUpperCase() + genre.slice(1);
                        break;
                    }
                }
                radioInfoList.push({ stream: streamValue, radioName: radioNameValue, genre: genre });
            } else {
                console.error('Кнопка радио не найдена');
            }
        }
        return radioInfoList;
    } catch (error) {
        console.error('Ошибка при получении информации о радио:', error);
        return null;
    }
}

async function fetchRadioInfoMultipleTimes(urls) {
    const radioInfoSet = new Set();
    for (let i = 0; i < urls.length; i++) {
        const radioInfo = await fetchRadioInfo(urls[i]);
        if (radioInfo) {
            radioInfo.forEach(info => {
                const infoString = JSON.stringify(info);
                radioInfoSet.add(infoString);
            });
        }
    }
    const radioInfoList = Array.from(radioInfoSet, infoString => JSON.parse(infoString));
    return radioInfoList;
}

const baseURL = 'https://onlineradiobox.com/ua/?cs=ua.radiorelax.com.ua';
const urls = Array.from({ length: 14 }, (_, i) => `${baseURL}&p=${i}&tzLoc=Europe%2FWarsaw`);

fetchRadioInfoMultipleTimes(urls)
    .then((radioInfoList) => {
        let logData = 'SiiNunit\n{\nlive_stream_def : .live_streams {\n';
        const lastResult = radioInfoList.length - 1;
        logData += ` stream_data: ${lastResult}\n`;
        radioInfoList.forEach((info, index) => {
            const formattedInfo = ` stream_data[${index}]: "${info.stream}|${info.radioName}|${info.genre}|UA|320|0"`;
            logData += formattedInfo + '\n';
        });
        logData += '}\n'; // Закрывающая скобка
        logData += '\n'; // Пустая строка
        logData += '}\n'; // Закрывающая скобка
        fs.writeFileSync('live_streams.sii', logData);
    })
    .catch((error) => {
        console.error('Error fetching radio info:', error);
    });
