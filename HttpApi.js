import Express from 'express';


export default class HttpApi {
    constructor(){
         
        
    }

    listen(addr,port){
        try{
            this.app=Express();
            this.app.use(Express.json());
           

            this.app.listen(port,addr,()=>{
                console.info("Http api listening on "+addr+":"+port);                              
            });                   

        }catch(e){
            console.error("Error starting http api",e);
        }
    }

     register(path,handler,method="GET"){
        if(!this.app)return;
        
        const onReq=async (req,res)=>{
            try{
                const result=await handler(req.url,req.body);
                res.json(result);
            }catch(e){
                res.status(500).json({error:e.message});
            }
        };
        console.log("Register api ",path,method)
        if(method=="POST")        this.app.post(path,onReq);
        else this.app.get(path,onReq);

        
    }
}