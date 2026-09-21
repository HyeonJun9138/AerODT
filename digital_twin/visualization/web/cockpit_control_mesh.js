// Small opaque cabin geometry, batched by the part that moves together.
export function controlMesh(C,id){
 const colour=hex=>C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(hex));
 const make=(geometry,at,hex,rotation)=>new C.GeometryInstance({geometry,id,modelMatrix:C.Matrix4.fromRotationTranslation(rotation??C.Matrix3.IDENTITY,new C.Cartesian3(...at),new C.Matrix4()),attributes:{color:colour(hex)}});
 const format=C.PerInstanceColorAppearance.VERTEX_FORMAT;
 return {
  box:(size,at,hex)=>make(C.BoxGeometry.fromDimensions({dimensions:new C.Cartesian3(...size),vertexFormat:format}),at,hex),
  cylinder:(bottom,top,length,at,hex)=>make(new C.CylinderGeometry({bottomRadius:bottom,topRadius:top,length,slices:24,vertexFormat:format}),at,hex,C.Matrix3.fromRotationX(Math.PI/2)),
  oval:(size,at,hex)=>make(new C.EllipsoidGeometry({radii:new C.Cartesian3(...size),stackPartitions:12,slicePartitions:20,vertexFormat:format}),at,hex),
  primitive:(parts,pick=true)=>new C.Primitive({geometryInstances:parts,appearance:new C.PerInstanceColorAppearance({closed:true,translucent:false}),modelMatrix:C.Matrix4.clone(C.Matrix4.IDENTITY,new C.Matrix4()),asynchronous:false,allowPicking:pick})
 };
}
