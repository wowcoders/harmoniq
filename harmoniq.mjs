window.AudioContext = window.AudioContext || window.webkitAudioContext

class AudioExtractor {
    async extractAudioRange(audioBuffer, startTime, endTime) {
        const offlineAudioContext = new OfflineAudioContext(
            audioBuffer.numberOfChannels,
            (endTime - startTime) * audioBuffer.sampleRate,
            audioBuffer.sampleRate
        )

        const source = offlineAudioContext.createBufferSource()
        source.buffer = audioBuffer
        source.start(0, startTime)
        source.connect(offlineAudioContext.destination)

        return new Promise((resolve) => {
            offlineAudioContext.startRendering().then((renderedBuffer) => {
                resolve(renderedBuffer)
            })
        })
    }

    async extractAndPlay(sourceAudioBuffer, startTime, endTime) {
        let extractedBuffer = await this.extractAudioRange(sourceAudioBuffer, startTime, endTime)

        let audioContext = new AudioContext()
        let source = audioContext.createBufferSource()
        source.buffer = extractedBuffer
        source.loop = false
        source.connect(audioContext.destination)
        source.start()
    }

    async extractAndDownloadAsWav(sourceAudioBuffer, startTime, endTime) {
        let extractedBuffer = await this.extractAudioRange(sourceAudioBuffer, startTime, endTime)
        let audioWavBlob = this.#audioBufferToWavBlob(extractedBuffer)
        this.#downloadBlob(audioWavBlob, `file_${Date.now()}.wav`)
    }

    async extractAndDownloadAsMp3(sourceAudioBuffer, startTime, endTime) {
        let extractedBuffer = await this.extractAudioRange(sourceAudioBuffer, startTime, endTime)
        let audioMP3Blob = this.#audioBufferToMP3Blob(extractedBuffer)
        this.#downloadBlob(audioMP3Blob, `file_${Date.now()}.mp3`)
    }

    #createWavHeader(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels
        const sampleRate = audioBuffer.sampleRate
        const bitsPerSample = 16
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
        const blockAlign = numChannels * (bitsPerSample / 8)
        const dataSize = audioBuffer.length * numChannels * (bitsPerSample / 8)

        const view = new DataView(new ArrayBuffer(44))

        this.#writeString(view, 0, 'RIFF')
        view.setUint32(4, 36 + dataSize, true)
        this.#writeString(view, 8, 'WAVE')

        this.#writeString(view, 12, 'fmt ')
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, numChannels, true)
        view.setUint32(24, sampleRate, true)
        view.setUint32(28, byteRate, true)
        view.setUint16(32, blockAlign, true)
        view.setUint16(34, bitsPerSample, true)

        this.#writeString(view, 36, 'data')
        view.setUint32(40, dataSize, true)

        return view.buffer
    }

    #writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i))
        }
    }

    #audioBufferToWavBlob(audioBuffer) {
        const header = this.#createWavHeader(audioBuffer)
        const pcmData = new Float32Array(audioBuffer.getChannelData(0))
        const pcmView = new DataView(new ArrayBuffer(pcmData.byteLength))

        for (let i = 0; i < pcmData.length; i++) {
            pcmView.setInt16(i * 2, pcmData[i] * 32767, true)
        }

        const blob = new Blob([header, pcmView.buffer], { type: 'audio/wav' })
        return blob
    }

    #audioBufferToMP3Blob(audioBuffer) {
        const channels = audioBuffer.numberOfChannels
        const sampleRate = audioBuffer.sampleRate
        const leftChannelData = audioBuffer.getChannelData(0)
        const rightChannelData = channels > 1 ? audioBuffer.getChannelData(1) : null

        const encoder = new lamejs.Mp3Encoder(channels, sampleRate, 128)

        const left = this.#convertFloat32ToInt16(leftChannelData)
        const right = rightChannelData ? this.#convertFloat32ToInt16(rightChannelData) : null

        let mp3Data = []
        const sampleBlockSize = 1152
        for (let i = 0; i < left.length; i += sampleBlockSize) {
            const leftChunk = left.subarray(i, i + sampleBlockSize)
            const rightChunk = right ? right.subarray(i, i + sampleBlockSize) : null
            const mp3buf = encoder.encodeBuffer(leftChunk, rightChunk)
            if (mp3buf.length > 0) {
                mp3Data.push(mp3buf)
            }
        }

        const mp3buf = encoder.flush()
        if (mp3buf.length > 0) {
            mp3Data.push(mp3buf)
        }

        const mp3Blob = new Blob(mp3Data, { type: 'audio/mp3' })
        return mp3Blob
    }

    #convertFloat32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length)
        for (let i = 0; i < float32Array.length; i++) {
            int16Array[i] = Math.max(-32768, Math.min(32767, float32Array[i] * 32768))
        }
        return int16Array
    }

    #downloadBlob(blob, fileName) {
        const url = URL.createObjectURL(blob)

        const link = document.createElement('a')
        link.href = url
        link.download = fileName

        link.click()

        URL.revokeObjectURL(url)
    }
}

export class AudioPlayer {
    constructor(parent, audio, width = 512, height = 120) {
        this.parent = parent
        this.height = height
        this.width = width
        this.audio = audio

        this.#init()

        this.#createView()

        this.#load()

        this.#registerEvents()
    }

    #init() {
        this.layer1 = null
        this.layer1ctx = null
        this.layer2 = null
        this.layer2ctx = null
        this.layer3 = null
        this.layer3ctx = null

        this.audioBuffer = null
        this.playingAudioSource = null
    }

    stop() {
        if (this.playingAudioSource) {
            this.playingAudioSource.stop()
            this.playingAudioSource = null
        }
    }

    play(start, end) {
        if (this.playingAudioSource) {
            this.stop()
            return
        }

        let audioContext = new AudioContext()

        let source = audioContext.createBufferSource()

        this.playingAudioSource = source

        source.buffer = this.audioBuffer
        source.loop = false
        source.connect(audioContext.destination)

        let draw = () => {
            let pos = (start + audioContext.currentTime) * (this.width / this.audioBuffer.duration)
            let ctx = this.layer3ctx
            let canvas = this.layer3
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.strokeStyle = "red"
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.moveTo(0 + pos, 0)
            ctx.lineTo(0 + pos, canvas.height)
            ctx.stroke()
        }
        let intervalId = setInterval(() => { draw() }, 50)
        source.onended = () => {
            this.playingAudioSource = null
            clearInterval(intervalId)
            draw()
        }
        source.start(0, start || 0, end)
    }

    #registerEvents() {
        const controller = new AbortController();
        this.canvasController = controller
        this.layer3.addEventListener('mouseup', this.#mouseup.bind(this), { signal: controller.signal })
        this.layer3.addEventListener('mousemove', this.#mousemove.bind(this), { signal: controller.signal })
        this.layer3.addEventListener('mousedown', this.#mousedown.bind(this), { signal: controller.signal })
        this.layer3.addEventListener('dblclick', this.#dblclick.bind(this), { signal: controller.signal })
    }

    isDragging = false
    startX = 0
    currentX = 0

    timeoutId = 0
    longPress = false

    ranges = []

    #addRange(start, end) {
        let i = 0
        let range = null
        for (i = 0; i < this.ranges.length; i++) {
            let r = this.ranges[i]
            if (r.start > start) {
                range = r
                break
            }
        }

        let r = i - 1 > -1 ? this.ranges[i - 1] : { start: -1, end: -1 }
        this.ranges.splice(i, 0, {
            start: (start > r.end) ? start : r.end + 1,
            end: (!range || end < range.start) ? end : range.start - 1
        })
        this.#drawRanges()
    }

    #drawRanges() {
        let ctx = this.layer2ctx
        let canvas = this.layer2
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        ctx.fillStyle = "rgba(0, 250, 255, 0.3)"
        ctx.strokeStyle = "rgba(0, 250, 255, 1)"
        ctx.lineWidth = 3

        for (let r of this.ranges) {
            ctx.fillRect(r.start, 0, r.end - r.start, canvas.height)
            ctx.strokeRect(r.start, 0, r.end - r.start, canvas.height)
        }
    }

    #mousedown(e) {
        this.isDragging = true
        this.startX = e.offsetX
        this.timeoutId = setTimeout(() => {
            this.longPress = true
        }, 200)
    }

    #mousemove(e) {
        if (!this.isDragging) return
        this.currentX = e.offsetX
    }

    #mouseup(event) {
        if (this.timeoutId) clearTimeout(this.timeoutId)

        this.timeoutId = 0

        this.isDragging = false

        if (event.button === 0) {
            const range = Math.abs(this.startX - this.currentX)
            if (this.longPress && range > 5) {
                let s = Math.min(this.startX, this.currentX)
                let e = Math.max(this.startX, this.currentX)
                this.#addRange(s, e)
            } else {
                let loc = this.#getMousePos(this.layer3, event)
                let r = this.#isInRange(loc)
                if (r) {
                    this.play(
                        loc.x / (this.width / this.audioBuffer.duration),
                        (r.end - loc.x) / (this.width / this.audioBuffer.duration)
                    )
                } else {
                    this.play(loc.x / (this.width / this.audioBuffer.duration))
                }
            }
        }
        this.longPress = false
    }

    #dblclick(event) {
        let loc = this.#getMousePos(this.layer3, event)
        let r = this.#isInRange(loc)
        if (r) {
            this.ranges = this.ranges.filter(i => i != r)
            this.#drawRanges()
        }
    }

    #isInRange(loc) {
        for (let r of this.ranges) {
            if (r.start <= loc.x && loc.x <= r.end) {
                return r
            }
        }
        return null
    }

    #getMousePos(canvas, evt) {
        return {
            x: evt.offsetX,
            y: evt.offsetY
        };
    }

    #closeContextMenu() {
        if (this.menu) {
            setTimeout(() => {
                this.menuController.abort();
                this.menu.remove();
            }, 3)
        }
    }

    #createView() {
        let width = this.width
        let height = this.height
        const tmpl = `
            <canvas class="ap_layer1" width="${width}" height="${height}"
                style="position: absolute; left: 0; top: 0; z-index: 0;"></canvas>
            <canvas class="ap_layer2" width="${width}" height="${height}"
                style="position: absolute; left: 0; top: 0; z-index: 1;"></canvas>                
            <canvas class="ap_layer3" width="${width}" height="${height}"
                style="position: absolute; left: 0; top: 0; z-index: 1;"></canvas>
        `
        const newDiv = document.createElement("div")
        this.view = newDiv
        newDiv.innerHTML = tmpl
        newDiv.style.position = "relative"
        newDiv.style.width = `${width}px`
        newDiv.style.height = `${height}px`
        newDiv.style.position = "relative"
        newDiv.classList.add("ap_container")
        document.querySelector(this.parent).appendChild(newDiv)

        this.layer1 = newDiv.querySelector(".ap_layer1")
        this.layer1ctx = this.layer1.getContext('2d')

        this.layer2 = newDiv.querySelector(".ap_layer2")
        this.layer2ctx = this.layer2.getContext('2d')

        this.layer3 = newDiv.querySelector(".ap_layer3")
        this.layer3ctx = this.layer3.getContext('2d')

        newDiv.addEventListener('contextmenu', (event) => {
            event.preventDefault()
            let loc = this.#getMousePos(this.layer3, event)
            let r = this.#isInRange(loc)
            if (r) {
                const menu = document.createElement('div');
                let doc = `<ul 
                    style="list-style-type:none;margin:0;padding:0;background-color: #f2f2f2;box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2);">
                    <li style='padding: 10px;cursor: pointer;'>Play This Clip</li>
                    <li style='padding: 10px;cursor: pointer;'>Download As WAV File</li>
                    <li style='padding: 10px;cursor: pointer;'>Download As MP3 File</li>
                </ul>`

                menu.innerHTML = doc
                menu.style.position = "absolute"
                menu.style.zIndex = "10000"
                menu.style.left = event.clientX + 'px';
                menu.style.top = event.clientY + 'px';
                menu.style.display = 'block';
                document.body.appendChild(menu);

                const controller = new AbortController();
                this.menuController = controller
                this.menu = menu

                const elements = menu.querySelectorAll("ul>li");

                elements.forEach((e) => e.addEventListener("mouseover", function () { this.style.backgroundColor = "#ddd"; }), { signal: controller.signal });
                elements.forEach((e) => e.addEventListener("mouseout", function () { this.style.backgroundColor = ""; }), { signal: controller.signal });

                elements.forEach((e) => e.addEventListener("click", (e) => {
                    let selected = e.currentTarget.innerHTML
                    if (selected == "Play This Clip") {
                        let start = r.start / (this.width / this.audioBuffer.duration)
                        let end = r.end / (this.width / this.audioBuffer.duration)
                        let ae = new AudioExtractor()
                        ae.extractAndPlay(this.audioBuffer, start, end)
                    } else if (selected == "Download As WAV File") {
                        let start = r.start / (this.width / this.audioBuffer.duration)
                        let end = r.end / (this.width / this.audioBuffer.duration)
                        let ae = new AudioExtractor()
                        ae.extractAndDownloadAsWav(this.audioBuffer, start, end)
                    } else if (selected == "Download As MP3 File") {
                        let start = r.start / (this.width / this.audioBuffer.duration)
                        let end = r.end / (this.width / this.audioBuffer.duration)
                        let ae = new AudioExtractor()
                        ae.extractAndDownloadAsMp3(this.audioBuffer, start, end)
                    }
                }), { signal: controller.signal });

                document.addEventListener('click', this.#closeContextMenu.bind(this), { signal: controller.signal });
            }
        })
    }

    #load() {
        let url = this.audio
        let req = new XMLHttpRequest()
        req.open("GET", url, true)
        req.responseType = "arraybuffer"
        req.onreadystatechange = (e) => {
            if (req.readyState == 4) {
                if (req.status == 200) {
                    let audioContext = new AudioContext()
                    audioContext.decodeAudioData(req.response,
                        (buffer) => {
                            this.audioBuffer = buffer
                            this.#displayBuffer()
                        }, () => this.#displayError('Decode error'))
                } else {
                    this.displayError('Failed to load')
                }
            }
        }
        req.send()
    }

    #displayBuffer() {
        let buff = this.audioBuffer
        let leftChannel = buff.getChannelData(0)

        let canvas = this.layer1
        let canvasWidth = canvas.width
        let canvasHeight = canvas.height

        let context = this.layer1ctx
        context.save()
        context.fillStyle = '#032a14'
        context.fillRect(0, 0, canvasWidth, canvasHeight)
        context.strokeStyle = '#221'
        context.globalCompositeOperation = 'lighter'
        context.translate(0, canvasHeight / 2)
        context.globalAlpha = 0.06
        for (let i = 0; i < leftChannel.length; i++) {
            let x = Math.floor(canvasWidth * i / leftChannel.length)
            let y = leftChannel[i] * canvasHeight / 2
            context.beginPath()
            context.moveTo(x, 0)
            context.lineTo(x + 1, y)
            context.stroke()
        }
        context.restore()
    }

    #displayError(message) {

    }

    destroy() {
        this.#closeContextMenu()
        this.stop()
        this.canvasController.abort()
        this.view.remove()
        this.#init()
    }
}
