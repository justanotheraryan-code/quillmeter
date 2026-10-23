# Third-party notices

## liquid-glass-react

`public/glass.js` adapts ideas from [liquid-glass-react](https://github.com/rdev/liquid-glass-react), which is
licensed under the MIT license. Quillmeter does not include or run the package (it is a React component and this
app has no build step); it ports the technique to plain JavaScript and CSS:

- the lean toward the cursor and the directional stretch (Quillmeter applies them to the hovered control only; the library also eases controls near the pointer)
- the rim light on a 1 px masked border that follows the pointer
- the press squash, and the idea of a displacement map for refraction on browsers that support it

The displacement map itself is drawn at runtime instead of using the library's image.

```text
Copyright 2025 MAX ROVENSKY

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
