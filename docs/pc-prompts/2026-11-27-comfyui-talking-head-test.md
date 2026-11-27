You're on Jon's Windows PC. Your job: make one test talking-head clip locally in ComfyUI, so Jon can compare it with the same test made in Runway and Higgsfield. It's a trial only. Don't change his existing ComfyUI workflows or Six Minutes Studio.

## Inputs
- Portrait: `portrait.png`. A 16:9 photo of Jon in a navy blazer, Orkney coast blurred behind.
- Voice: `voice_test.mp3`. 8 seconds of Jon speaking.
- Jon saved both from his chat. Ask him where (probably `Downloads`) before you start.

## ComfyUI on this PC
- ComfyUI Desktop, build "SixMinutesOn", server at http://127.0.0.1:8188. Studio starts it, or Jon opens it.
- Existing workflows live in `S:\Youtube video ideas\ComfyUI workflows\`. Leave `broll_ltx.json` and `animate_i2v.json` untouched.
- Outputs go to `C:\Users\Jon\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output`.

## What to do
1. Check ComfyUI answers: `curl http://127.0.0.1:8188/system_stats`. Note the GPU name and its VRAM.
2. Pick an audio-driven talking-head workflow. In order of preference:
   - **Wan 2.2 S2V (sound-to-video).** ComfyUI's own template: Workflow → Browse Templates → Video → "Wan2.2 S2V". It takes one image plus an audio clip.
   - **Wan InfiniteTalk / MultiTalk,** if a template or the WanVideoWrapper custom nodes are already installed.
   - Choose one that fits the GPU's VRAM. Use the fp8 or quantised model variants on 16–24 GB.
3. If it needs model downloads or custom nodes, tell Jon first:
   - what will be downloaded or installed;
   - roughly how many GB;
   - where it will go.

   Wait for his OK. Install only from ComfyUI's template model links or ComfyUI Manager.
4. Load the template and set:
   - **image:** the portrait;
   - **audio:** the voice clip;
   - **length:** the clip's 8 s, at the template's fps;
   - **resolution:** as close to 1280×720 as the template allows;
   - **positive prompt:** "A man speaks directly to the camera, calm documentary presenter, lips synced to the speech, small natural head movements, gentle hand gestures, steady camera, soft-focus coastal background stays still, warm natural light, photorealistic."
   - **negative prompt:** the template's default.
   - Use a fixed seed, and write it down.
5. Run it. Watch the console for out-of-memory errors. If it runs out of memory, lower the resolution or length per the template's notes and try once more.
6. Save the workflow, in API format, as `S:\Youtube video ideas\ComfyUI workflows\talking_head_test.json`. If the output is a video without sound, mux the voice clip onto it with ffmpeg: `ffmpeg -i <video> -i voice_test.mp3 -c:v copy -c:a aac -shortest talking_head_pc_test.mp4`. Put the final file somewhere Jon can find it easily, e.g. his Desktop.

## Report back to Jon (plain English, short)
- Where the finished clip is.
- Which workflow and model you used, the resolution, and the seed.
- How long the render took, and the GPU and VRAM.
- Anything you installed, with sizes.
- Your honest read: does the mouth match the words, does the face stay his, and is there any flicker or warping?
- The node ids that a script would need to drive this workflow: the image input, audio input, prompt, seed, length and the video output node. Six Minutes Studio may automate it later.
