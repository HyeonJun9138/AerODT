"""Small deterministic PBR surfaces, embedded in the authored facility GLBs.

No remote assets. Linear ORM/normal maps and sRGB base colour use one UV set.
"""
import io
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

def surface(name, color, rough, metal, size=256):
    rng=np.random.default_rng(90210+sum(map(ord,name)))
    fine=rng.random((size,size)).astype(np.float32)
    seed=Image.fromarray((rng.random((16,16))*255).astype('uint8'))
    broad=np.asarray(seed.resize((size,size),Image.Resampling.BICUBIC),dtype=float)/255
    y,x=np.mgrid[0:size,0:size]/size
    grain=(fine-.5)*.035+(broad-.5)*.05
    height=(fine-.5)*.015
    if name=='limestone':
        grain=(fine-.5)*.12+(broad-.5)*.08
        height=(fine-.5)*.10+(broad-.5)*.03
    elif name=='timber':
        grain+=np.sin(x*280+broad*5)*.055
        height+=np.sin(x*280+broad*5)*.028
    elif name in ('anodized','cladding'):
        grain+=(rng.random((size,1))-.5)*.025
        height=(fine-.5)*.007
    elif name=='glass':
        # Faint laminated-glass tint, not a painted photograph of windows.
        grain=(1-y)*.13+np.exp(-((x-.27)/.23)**2)*.06-.045
        height*=.025
    base=np.clip(np.asarray(color[:3])[None,None,:]*(1+grain[:,:,None]),0,1)
    rgba=np.concatenate([base,np.full((size,size,1),color[3])],axis=2)
    base_image=Image.fromarray((rgba*255).astype('uint8'),'RGBA')
    if name=='screen':
        draw=ImageDraw.Draw(base_image)
        draw.rounded_rectangle((19,22,237,234),radius=8,fill=(12,27,30,255),outline=(51,74,79,255),width=2)
        draw.text((32,39),'DC / CHARGE',fill=(151,197,184,255))
        for i in range(5):draw.rectangle((32+i*36,104,57+i*36,138),fill=(96,155,139,255))
        for i in range(3):draw.line((32,172+i*13,195-i*32,172+i*13),fill=(75,105,109,255),width=3)
    dx=(np.roll(height,-1,1)-np.roll(height,1,1))*1.8
    dy=(np.roll(height,-1,0)-np.roll(height,1,0))*1.8
    normal=np.stack([-dx,-dy,np.ones_like(dx)],axis=2)
    normal/=np.linalg.norm(normal,axis=2,keepdims=True)
    # Subtle perimeter recess darkening. Physical cast shadows stay separate.
    edge=np.minimum.reduce([x,1-x,y,1-y])
    ao=.83+.17*np.clip(edge/.07,0,1)
    orm=np.stack([ao,np.clip(rough+(fine-.5)*.045,0,1),np.full_like(x,metal)],axis=2)
    def png(image):
        out=io.BytesIO();image.save(out,format='PNG',optimize=True);return out.getvalue()
    return [png(base_image),png(Image.fromarray((orm*255).astype('uint8'),'RGB')),
            png(Image.fromarray(((normal*.5+.5)*255).astype('uint8'),'RGB'))]
