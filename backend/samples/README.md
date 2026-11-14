# Demo reference

`iphone15-demo-reference.jpg` is a resized, metadata-stripped copy of the black
iPhone 15 photo used in the existing POC. Original source:
https://blog.home-kobetsu.com/posts/52936770/

It seeds references for demo order `1` only when `iphone-15` is not already
enrolled. Existing station reference photos are preserved. It is an example
reference, not authenticated ground truth. Replace it with your own enrolled
reference photos using `python -m backend.enroll_iphone15 --reference PATH --replace`.
