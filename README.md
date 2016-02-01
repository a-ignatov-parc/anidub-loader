# anidub-loader

Download TV Series from http://online.anidub.com/ in Plex Media Server notation

## Usage

```bash
npm start page=http://online.anidub.com/anime_tv/full/2914-kovboy-bibop-cowboy-bebop-04-iz-26.html plex-path=~/Movies/TV\ Shows/ season=1
```

## Options

- `page` — Url for tv series home page on http://online.anidub.com/

- `plex-path` — Path to where videos will be saved

  > Default: `./`

- `title` — TV Series title.

- `season` — Season number.

  > Default: 1

- `episodes` — Range of episodes to download. 

  Examples:
  
  ```
  episodes=1
  episodes=1,24
  episodes=1-24
  episodes=1-24,32
  ```
  
## Limitations

- Currently supports processing only for vk.com video hosting.
