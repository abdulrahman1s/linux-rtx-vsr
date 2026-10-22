const main = () => document.querySelector<HTMLVideoElement>('#main')!;
document.getElementById('play')!.onclick = () => (main().paused ? main().play() : main().pause());
document.getElementById('fullscreen')!.onclick = () =>
  document.querySelector('.player')!.requestFullscreen();
document.getElementById('replace')!.onclick = () => {
  const v = main().cloneNode() as HTMLVideoElement;
  main().replaceWith(v);
  v.play();
};
document.getElementById('seek')!.onclick = () => {
  main().currentTime = 5;
};
document.getElementById('spa')!.onclick = () => history.pushState({}, '', '/watch/next');
